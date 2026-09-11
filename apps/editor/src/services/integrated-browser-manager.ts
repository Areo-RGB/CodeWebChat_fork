import * as vscode from 'vscode'
import { CHATBOTS } from '@shared/constants/chatbots'
import { default_system_instructions } from '@shared/constants/default-system-instructions'
import { Logger } from '@shared/utils/logger'
import { WebConfiguration } from '@shared/types/web-configuration'
import { ConfigWebConfigurationFormat } from '@/utils/web-configuration-format-converters'
import { ApplyResponseCommandArgs } from '@/commands/apply-response-command/response-processor'

type CdpMessage = {
  id?: number
  method?: string
  params?: any
  result?: any
  error?: { code?: number; message?: string }
  sessionId?: string
}

type PendingRequest = {
  resolve: (value: any) => void
  reject: (error: Error) => void
}

type BrowserContext = {
  tab: vscode.BrowserTab
  session: vscode.BrowserCDPSession
  cdp: CdpClient
  page_session_id: string
  binding_disposable?: vscode.Disposable
}

class CdpClient implements vscode.Disposable {
  private next_id = 1
  private pending = new Map<number, PendingRequest>()
  private message_emitter = new vscode.EventEmitter<CdpMessage>()
  private message_disposable: vscode.Disposable

  public readonly on_message = this.message_emitter.event

  constructor(private readonly session: vscode.BrowserCDPSession) {
    this.message_disposable = session.onDidReceiveMessage((raw_message) => {
      const message = raw_message as CdpMessage

      if (message.id !== undefined) {
        const pending = this.pending.get(message.id)
        if (pending) {
          this.pending.delete(message.id)
          if (message.error) {
            pending.reject(
              new Error(
                `CDP error ${message.error.code ?? ''}: ${message.error.message ?? 'Unknown error'}`.trim()
              )
            )
          } else {
            pending.resolve(message.result)
          }
        }
      }

      this.message_emitter.fire(message)
    })
  }

  public async send(
    method: string,
    params: Record<string, unknown> = {},
    session_id?: string
  ): Promise<any> {
    const id = this.next_id++
    const response = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })

    try {
      await this.session.sendMessage({
        id,
        method,
        params,
        ...(session_id ? { sessionId: session_id } : {})
      })
    } catch (error) {
      this.pending.delete(id)
      throw error
    }

    return response
  }

  public wait_for_event(
    predicate: (message: CdpMessage) => boolean,
    timeout_ms = 15_000
  ): Promise<CdpMessage> {
    return new Promise((resolve, reject) => {
      let disposable: vscode.Disposable | undefined
      const timeout = setTimeout(() => {
        disposable?.dispose()
        reject(new Error('Timed out waiting for CDP event'))
      }, timeout_ms)

      disposable = this.on_message((message) => {
        if (!predicate(message)) return
        clearTimeout(timeout)
        disposable?.dispose()
        resolve(message)
      })
    })
  }

  public dispose() {
    this.message_disposable.dispose()
    this.message_emitter.dispose()
    for (const pending of this.pending.values()) {
      pending.reject(new Error('CDP session closed'))
    }
    this.pending.clear()
  }
}

/**
 * Experimental browser transport for the personal CDP branch.
 *
 * This intentionally keeps the old WebSocketManager public surface through a
 * compatibility re-export so the rest of Code Web Chat does not need a broad
 * transport refactor yet. Only Google AI Studio is supported on this branch.
 */
export class IntegratedBrowserManager implements vscode.Disposable {
  private readonly extension_context: vscode.ExtensionContext
  private readonly _on_connection_status_change =
    new vscode.EventEmitter<boolean>()
  private active_context: BrowserContext | null = null

  public readonly on_connection_status_change =
    this._on_connection_status_change.event

  constructor(extension_context: vscode.ExtensionContext) {
    this.extension_context = extension_context
    this.extension_context.subscriptions.push(
      this._on_connection_status_change,
      this
    )
  }

  public supports_chatbot(chatbot?: string): boolean {
    return chatbot === 'AI Studio'
  }

  public is_connected_with_browser(): boolean {
    try {
      return (
        typeof vscode.window.openBrowserTab === 'function' &&
        Array.isArray(vscode.window.browserTabs)
      )
    } catch {
      return false
    }
  }

  public async initialize_chat(params: {
    text: string
    web_configuration_name: string
    raw_instructions?: string
    inject_apply_response_button?: boolean
  }): Promise<boolean> {
    if (!this._ensure_browser_api()) return false

    const config = vscode.workspace.getConfiguration('codeWebChat')
    const web_configurations =
      config.get<ConfigWebConfigurationFormat[]>('webConfigurations') ?? []
    const web_configuration = web_configurations.find(
      (item) => item.name === params.web_configuration_name
    )

    if (!web_configuration) return false

    return this._initialize_ai_studio({
      text: params.text,
      web_configuration: {
        name: web_configuration.name,
        chatbot: web_configuration.chatbot,
        model: web_configuration.model,
        reasoning_effort: web_configuration.reasoningEffort,
        system_instructions: web_configuration.systemInstructions,
        options: web_configuration.options,
        port: web_configuration.port,
        new_url: web_configuration.newUrl,
        is_pinned: web_configuration.isPinned
      },
      raw_instructions: params.raw_instructions,
      auto_apply_response: params.inject_apply_response_button ?? false
    })
  }

  public async preview_web_configuration(params: {
    instruction: string
    web_configuration: WebConfiguration
    raw_instructions: string
    inject_apply_response_button?: boolean
  }): Promise<boolean> {
    if (!this._ensure_browser_api()) return false

    return this._initialize_ai_studio({
      text: params.instruction,
      web_configuration: params.web_configuration,
      raw_instructions: params.raw_instructions,
      auto_apply_response: params.inject_apply_response_button ?? false
    })
  }

  private _ensure_browser_api(): boolean {
    if (this.is_connected_with_browser()) return true

    vscode.window.showErrorMessage(
      'The VS Code Integrated Browser proposed API is unavailable. Start a VS Code build that contains the browser proposal with --enable-proposed-api robertpiosik.gemini-coder.'
    )
    this._on_connection_status_change.fire(false)
    return false
  }

  private async _initialize_ai_studio(params: {
    text: string
    web_configuration: WebConfiguration
    raw_instructions?: string
    auto_apply_response: boolean
  }): Promise<boolean> {
    if (!this.supports_chatbot(params.web_configuration.chatbot)) {
      vscode.window.showWarningMessage(
        'This experimental Integrated Browser branch supports AI Studio only.'
      )
      return false
    }

    try {
      const url = this._get_ai_studio_url(params.web_configuration)
      const context = await this._open_browser_context(url)

      await this._wait_until_ready(context)
      await this._install_response_bridge({
        context,
        raw_instructions: params.raw_instructions,
        auto_apply_response: params.auto_apply_response
      })
      await this._configure_ai_studio(context, params.web_configuration)
      await this._enter_prompt(context, params.text)

      Logger.info({
        function_name: 'IntegratedBrowserManager._initialize_ai_studio',
        message: 'AI Studio prompt autofilled through Integrated Browser CDP',
        data: { url, auto_apply_response: params.auto_apply_response }
      })

      return true
    } catch (error) {
      Logger.error({
        function_name: 'IntegratedBrowserManager._initialize_ai_studio',
        message:
          'Failed to initialize AI Studio through Integrated Browser CDP',
        data: error
      })
      vscode.window.showErrorMessage(
        `Could not initialize AI Studio in the VS Code Integrated Browser: ${error instanceof Error ? error.message : String(error)}`
      )
      return false
    }
  }

  private _get_ai_studio_url(web_configuration: WebConfiguration): string {
    const config = vscode.workspace.getConfiguration('codeWebChat')
    const ai_studio_user_id = config.get<number | null>('aiStudioUserId')
    let base_url = CHATBOTS['AI Studio'].url

    if (ai_studio_user_id !== null && ai_studio_user_id !== undefined) {
      base_url = base_url.replace(
        'https://aistudio.google.com/',
        `https://aistudio.google.com/u/${ai_studio_user_id}/`
      )
    }

    if (web_configuration.model) {
      const separator = base_url.includes('?') ? '&' : '?'
      return `${base_url}${separator}model=${encodeURIComponent(web_configuration.model)}`
    }

    return base_url
  }

  private async _open_browser_context(url: string): Promise<BrowserContext> {
    await this._dispose_active_context()

    const tab = await vscode.window.openBrowserTab(url, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: false
    })
    const session = await tab.startCDPSession()
    const cdp = new CdpClient(session)

    try {
      const browser_attach = await cdp.send('Target.attachToBrowserTarget')
      const browser_session_id = browser_attach?.sessionId as string | undefined
      if (!browser_session_id) {
        throw new Error('Could not attach to Integrated Browser target')
      }

      const page_created = cdp.wait_for_event(
        (message) =>
          message.method === 'Target.targetCreated' &&
          message.sessionId === browser_session_id &&
          message.params?.targetInfo?.type === 'page'
      )
      await cdp.send(
        'Target.setDiscoverTargets',
        { discover: true },
        browser_session_id
      )
      const page_target = (await page_created).params?.targetInfo
      if (!page_target?.targetId) {
        throw new Error('Integrated Browser page target was not found')
      }

      const page_attach = await cdp.send(
        'Target.attachToTarget',
        { targetId: page_target.targetId, flatten: true },
        browser_session_id
      )
      const page_session_id = page_attach?.sessionId as string | undefined
      if (!page_session_id) {
        throw new Error('Could not attach to AI Studio page target')
      }

      await cdp.send('Runtime.enable', {}, page_session_id)
      await cdp.send('Page.enable', {}, page_session_id)

      const context: BrowserContext = {
        tab,
        session,
        cdp,
        page_session_id
      }
      this.active_context = context
      this._on_connection_status_change.fire(true)

      await this._wait_for_condition(
        context,
        `location.href.startsWith('https://aistudio.google.com/') && document.readyState !== 'loading'`,
        30_000,
        'AI Studio page did not finish loading'
      )

      return context
    } catch (error) {
      cdp.dispose()
      await Promise.resolve(session.close()).catch(() => undefined)
      throw error
    }
  }

  private async _evaluate<T>(
    context: BrowserContext,
    expression: string
  ): Promise<T> {
    const result = await context.cdp.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      },
      context.page_session_id
    )

    if (result?.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'Runtime.evaluate failed'
      )
    }

    return result?.result?.value as T
  }

  private async _wait_for_condition(
    context: BrowserContext,
    expression: string,
    timeout_ms: number,
    timeout_message: string
  ): Promise<void> {
    const started_at = Date.now()
    while (Date.now() - started_at < timeout_ms) {
      try {
        const ready = await this._evaluate<boolean>(context, expression)
        if (ready) return
      } catch {
        // The page may still be replacing its execution context while loading.
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    throw new Error(timeout_message)
  }

  private async _wait_until_ready(context: BrowserContext): Promise<void> {
    await this._wait_for_condition(
      context,
      `(() => {
        if (!document.querySelector('ms-zero-state')) return false;
        if (window.innerWidth <= 960) {
          return !!document.querySelector('button.runsettings-toggle-button');
        }
        return !!document.querySelector('button.model-selector-card');
      })()`,
      30_000,
      'AI Studio controls did not become ready'
    )
  }

  private async _configure_ai_studio(
    context: BrowserContext,
    web_configuration: WebConfiguration
  ): Promise<void> {
    const system_instructions =
      web_configuration.system_instructions || default_system_instructions
    await this._enter_system_instructions(context, system_instructions)

    if (web_configuration.reasoning_effort) {
      await this._set_reasoning_effort(
        context,
        web_configuration.reasoning_effort
      )
    }

    await this._set_options(context, web_configuration.options ?? [])
  }

  private async _enter_system_instructions(
    context: BrowserContext,
    system_instructions: string
  ): Promise<void> {
    const expression = `
      (async () => {
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const setTextareaValue = (textarea, value) => {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          if (setter) setter.call(textarea, value);
          else textarea.value = value;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const openPanel = async () => {
          if (window.innerWidth > 960 || document.querySelector('ms-right-side-panel > div')) return;
          const tuneButton = document.querySelector('button.runsettings-toggle-button');
          if (!tuneButton) throw new Error('Tune button not found');
          tuneButton.click();
          await delay(250);
        };

        await openPanel();
        const systemButton = document.querySelector('button[data-test-system-instructions-card]');
        if (!systemButton) throw new Error('System instructions button not found');
        systemButton.click();
        await nextFrame();

        const panel = document.querySelector('ms-system-instructions');
        const textarea = panel?.querySelector('textarea');
        const closeButton = document.querySelector('mat-dialog-container button[data-test-close-button]');
        if (!textarea || !closeButton) throw new Error('System instructions dialog is incomplete');

        setTextareaValue(textarea, ${JSON.stringify(system_instructions)});
        await nextFrame();
        closeButton.click();
        await nextFrame();
        return true;
      })()
    `

    await this._evaluate<boolean>(context, expression)
  }

  private async _set_reasoning_effort(
    context: BrowserContext,
    reasoning_effort: string
  ): Promise<void> {
    const expression = `
      (async () => {
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        if (window.innerWidth <= 960 && !document.querySelector('ms-right-side-panel > div')) {
          const tuneButton = document.querySelector('button.runsettings-toggle-button');
          if (!tuneButton) throw new Error('Tune button not found');
          tuneButton.click();
          await delay(250);
        }

        const setting = document.querySelector('ms-thinking-level-setting mat-form-field > div');
        if (!setting) throw new Error('Thinking level setting not found');
        setting.click();
        await nextFrame();

        const listbox = document.querySelector('div[role="listbox"]');
        if (!listbox) throw new Error('Thinking level options were not found');
        const target = ${JSON.stringify(
          reasoning_effort.charAt(0).toUpperCase() + reasoning_effort.slice(1)
        )};
        const option = Array.from(listbox.querySelectorAll('mat-option')).find(
          (item) => item.textContent?.trim() === target
        );
        if (!option) throw new Error('Requested thinking level was not found: ' + target);
        option.click();
        await nextFrame();
        return true;
      })()
    `

    await this._evaluate<boolean>(context, expression)
  }

  private async _set_options(
    context: BrowserContext,
    options: string[]
  ): Promise<void> {
    const expression = `
      (async () => {
        const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const options = ${JSON.stringify(options)};
        const settingsItems = Array.from(document.querySelectorAll('div.settings-item'));
        const tools = settingsItems.find((item) => {
          const title = item.querySelector('p.group-title');
          return title?.textContent?.trim() === 'Tools';
        });
        if (tools && !tools.classList.contains('expanded')) {
          tools.click();
          await nextFrame();
        }

        if (options.includes('hide-panel')) {
          sessionStorage.setItem('should-hide-panel', 'true');
        } else {
          sessionStorage.removeItem('should-hide-panel');
        }

        const groundingButton = document.querySelector('div[data-test-id="searchAsAToolTooltip"] button');
        if (groundingButton) {
          const checked = groundingButton.getAttribute('aria-checked') === 'true';
          const shouldBeChecked = options.includes('grounding-with-google-search');
          if (checked !== shouldBeChecked) groundingButton.click();
        }

        if (options.includes('url-context')) {
          const urlContextButton = document.querySelector('div[data-test-id="browseAsAToolTooltip"] button');
          if (urlContextButton) urlContextButton.click();
        }

        await nextFrame();
        return true;
      })()
    `

    await this._evaluate<boolean>(context, expression)
  }

  private async _enter_prompt(
    context: BrowserContext,
    prompt: string
  ): Promise<void> {
    const expression = `
      (async () => {
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const textarea = document.querySelector('textarea[formcontrolname="promptText"]');
        if (!textarea) throw new Error('Prompt textarea not found');

        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(textarea, ${JSON.stringify(prompt)});
        else textarea.value = ${JSON.stringify(prompt)};
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
        await nextFrame();

        const startedAt = Date.now();
        while (Date.now() - startedAt < 15000) {
          const tokenCount = document.querySelector('span.v3-token-count-value')?.textContent?.trim();
          if (tokenCount && !tokenCount.startsWith('0')) break;
          await delay(100);
        }

        if (window.innerWidth <= 960 && document.querySelector('ms-right-side-panel > div')) {
          const closeButton = document.querySelector('ms-run-settings button[iconname="close"]');
          closeButton?.click();
        } else if (sessionStorage.getItem('should-hide-panel') === 'true') {
          const closeButton = document.querySelector('ms-run-settings button[iconname="close"]');
          closeButton?.click();
        }

        textarea.focus();
        return true;
      })()
    `

    await this._evaluate<boolean>(context, expression)
  }

  private async _install_response_bridge(params: {
    context: BrowserContext
    raw_instructions?: string
    auto_apply_response: boolean
  }): Promise<void> {
    if (!params.auto_apply_response) return

    const { context } = params
    const binding_name = '__cwcAiStudioResponse'

    await context.cdp.send(
      'Runtime.addBinding',
      { name: binding_name },
      context.page_session_id
    )

    params.context.binding_disposable?.dispose()
    params.context.binding_disposable = context.cdp.on_message(
      async (message) => {
        if (
          message.method !== 'Runtime.bindingCalled' ||
          message.sessionId !== context.page_session_id ||
          message.params?.name !== binding_name
        ) {
          return
        }

        try {
          const payload = JSON.parse(message.params.payload) as {
            kind: 'apply-response' | 'copy-error'
            response?: string
            url?: string
            message?: string
          }

          if (payload.kind === 'copy-error') {
            vscode.window.showWarningMessage(
              payload.message ??
                'AI Studio response could not be copied. Check clipboard permission for aistudio.google.com.'
            )
            return
          }

          if (!payload.response) return

          await vscode.commands.executeCommand('codeWebChat.applyResponse', {
            response: payload.response,
            raw_instructions: params.raw_instructions,
            url: payload.url
          } as ApplyResponseCommandArgs)
        } catch (error) {
          Logger.error({
            function_name: 'IntegratedBrowserManager._install_response_bridge',
            message: 'Failed to process AI Studio response binding',
            data: error
          })
        }
      }
    )

    const observer_expression = `
      (() => {
        window.__cwcAiStudioObserver?.disconnect?.();
        const bindingName = ${JSON.stringify(binding_name)};
        const notify = (payload) => window[bindingName](JSON.stringify(payload));
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        const findMarkdownCopyButton = () => Array.from(document.querySelectorAll('button')).find(
          (button) => button.textContent?.includes('markdown_copy')
        );

        const copyMarkdown = async (footer) => {
          const chatTurn = footer.closest('.chat-turn-container');
          if (!chatTurn) throw new Error('AI Studio chat turn container not found');

          const clickCopy = async () => {
            const optionsButton = chatTurn.querySelector('ms-chat-turn-options > div > button');
            if (!optionsButton) throw new Error('AI Studio response options button not found');
            optionsButton.click();
            await delay(75);
            const markdownCopyButton = findMarkdownCopyButton();
            if (!markdownCopyButton) throw new Error('AI Studio Copy markdown button not found');
            markdownCopyButton.click();
            await delay(500);
          };

          await clickCopy();
          let response = '';
          try {
            response = await navigator.clipboard.readText();
          } catch (error) {
            throw new Error('Clipboard access was denied for aistudio.google.com');
          }

          if (!response) {
            await delay(300);
            await clickCopy();
            response = await navigator.clipboard.readText();
          }

          return response;
        };

        document.querySelectorAll('ms-chat-turn .turn-footer').forEach((footer) => {
          footer.setAttribute('data-cwc-cdp-processed', 'true');
        });

        let debounceTimer;
        const observer = new MutationObserver(() => {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(async () => {
            const footers = Array.from(document.querySelectorAll('ms-chat-turn .turn-footer'));
            for (const footer of footers) {
              const hasThumbUp =
                footer.querySelector('button[iconname="thumb_up"]') ||
                Array.from(footer.querySelectorAll('button span')).some(
                  (span) => span.textContent?.trim() === 'thumb_up'
                );
              if (!hasThumbUp || footer.hasAttribute('data-cwc-cdp-processed')) continue;

              footer.setAttribute('data-cwc-cdp-processed', 'true');

              try {
                await delay(300);
                const response = await copyMarkdown(footer);
                if (!response) {
                  notify({
                    kind: 'copy-error',
                    message: 'AI Studio clipboard was still empty after retrying Copy markdown.'
                  });
                  observer.disconnect();
                  continue;
                }
                notify({ kind: 'apply-response', response, url: location.href });
                observer.disconnect();
              } catch (error) {
                notify({
                  kind: 'copy-error',
                  message: error instanceof Error ? error.message : String(error)
                });
                observer.disconnect();
              }
            }
          }, 100);
        });

        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true
        });
        window.__cwcAiStudioObserver = observer;
        return true;
      })()
    `

    await this._evaluate<boolean>(context, observer_expression)
  }

  private async _dispose_active_context(): Promise<void> {
    const context = this.active_context
    this.active_context = null
    if (!context) return

    context.binding_disposable?.dispose()
    context.cdp.dispose()
    await Promise.resolve(context.session.close()).catch(() => undefined)
  }

  public dispose() {
    void this._dispose_active_context()
  }
}
