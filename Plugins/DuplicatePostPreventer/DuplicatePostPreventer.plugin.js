/**
 * @name DuplicatePostPreventer
 * @author Happywezer
 * @description Block re-sharing posts
 * @version 1.2.1
 */

module.exports = class DuplicatePostPreventer {
	constructor() {
		this.settings = { cooldownMs: 3000, waitingTimeMs: 3000, isDebug: true, isShowToasts: true };
		this.lastSearchTime = 0;
		this.isBackgroundSearchingNow = false;
		this.optimisticMessages = new Map();
	}

	async start() {
		const savedSettings = BdApi.Data.load("DuplicatePostPreventer", "settings");

		if (savedSettings && typeof savedSettings === "object") {
			this.settings = {
				...this.settings,
				...savedSettings,
			};
		}

		if (await this.waitInitialization()) {
			this.patchSidebarModule();
			this.addStyles();
			this.overrideSendMessage();
			this.settings.isShowToasts && BdApi.UI.showToast("[DuplicatePostPreventer] Plugin activated successfully", { type: "success" });
		} else {
			this.settings.isShowToasts && BdApi.UI.showToast("[DuplicatePostPreventer] Required modules not found", { type: "error" });
			setTimeout(() => BdApi.Plugins.disable("DuplicatePostPreventer"), 300);
		}
	}

	stop() {
		this.removeWarning();
		this.removeAllOptimisticMessages();
		this.isBackgroundSearchingNow = false;
		BdApi.Patcher.unpatchAll("DuplicatePostPreventer");
		BdApi.DOM.removeStyle("DuplicatePostPreventer");
	}

	initializeModules() {
		this.settings.isDebug && console.log("[DuplicatePostPreventer] Binding Discord modules...");

		this.searchModule = BdApi.Webpack.getByKeys("fetchMessages", "setSearchInputText", { searchExports: true });
		this.searchSidebarModule = BdApi.Webpack.getByKeys("setSidebarOpen", { searchExports: true });
		this.searchMessageStore = BdApi.Webpack.getStore("SearchMessageStore");
		this.selectedGuildStore = BdApi.Webpack.getStore("SelectedGuildStore");
		this.selectedChannelStore = BdApi.Webpack.getStore("SelectedChannelStore");
		this.channelStoreModule = BdApi.Webpack.getByKeys("getChannel", "hasChannel");
		this.messageActionsModule = BdApi.Webpack.getByKeys("sendMessage", "editMessage");
		this.langFilterMap = BdApi.Webpack.getModule(m => typeof m.FILTER_IN === "object", { searchExports: true });

		const renderSidebarModuleRaw = BdApi.Webpack.getModule(m => m?.type?.toString?.()?.includes?.("getSidebarState"), {
			searchExports: true,
			raw: true,
		});
		this.renderSidebarModule = Object.values(renderSidebarModuleRaw?.declarations ?? {}).find(val => val?.prototype?.renderSidebar);

		return [
			this.searchModule,
			this.renderSidebarModule,
			this.searchSidebarModule,
			this.searchMessageStore,
			this.selectedGuildStore,
			this.selectedChannelStore,
			this.channelStoreModule,
			this.messageActionsModule,
			this.langFilterMap,
		];
	}

	waitInitialization(timeoutMs = 15000, checkIntervalMs = 500) {
		return new Promise(resolve => {
			const startTime = Date.now();

			const check = () => {
				const requiredModules = this.initializeModules();

				if (requiredModules.every(Boolean)) {
					this.settings.isDebug && console.log("[DuplicatePostPreventer] All modules successfully bound.");
					resolve(true);
					return;
				}

				if (Date.now() - startTime >= timeoutMs) {
					this.settings.isDebug &&
						console.error("[DuplicatePostPreventer] Failed to find required Discord modules.", {
							hasSearchModule: !!this.searchModule,
							hasrenderSidebarModule: !!this.renderSidebarModule,
							hasSearchSidebarModule: !!this.searchSidebarModule,
							hasSearchMessageStore: !!this.searchMessageStore,
							hasSelectedGuildStore: !!this.selectedGuildStore,
							hasSelectedChannelStore: !!this.selectedChannelStore,
							hasChannelStoreModule: !!this.channelStoreModule,
							hasMessageActionsModule: !!this.messageActionsModule,
							hasLangFilterMap: !!this.langFilterMap,
						});

					resolve(false);
					return;
				}

				setTimeout(check, checkIntervalMs);
			};

			check();
		});
	}

	patchSidebarModule() {
		BdApi.Patcher.instead("DuplicatePostPreventer", this.searchSidebarModule, "setSidebarOpen", (instance, args, originalFunc) => {
			if (this.isBackgroundSearchingNow) return;
			originalFunc.apply(instance, args);
		});

		BdApi.Patcher.instead("DuplicatePostPreventer", this.renderSidebarModule.prototype, "renderSidebar", (instance, args, originalFunc) => {
			if (this.isBackgroundSearchingNow) return;
			originalFunc.apply(instance, args);
		});
	}

	getPostId(content) {
		if (!content) return undefined;
		const regexsArray = [/(status\/\d+)/i, /(artworks\/\d+)/i, /(shorts\/[a-zA-Z0-9_-]+)/i, /(p\/[a-zA-Z0-9_-]+)/i];
		for (const regex of regexsArray) {
			const match = content.match(regex);
			if (match) return match[1];
		}
		return undefined;
	}

	overrideSendMessage() {
		BdApi.Patcher.instead("DuplicatePostPreventer", this.messageActionsModule, "sendMessage", async (instance, args, originalFunc) => {
			this.settings.isDebug && console.log("[DuplicatePostPreventer] patched sendMessage called");

			const channelId = args[0];
			const message = args[1];
			const content = message?.content;

			const postId = this.getPostId(content);

			if (!postId) {
				return originalFunc.apply(instance, args);
			}

			const currentTime = Date.now();
			if (currentTime - this.lastSearchTime < this.settings.cooldownMs) {
				this.settings.isDebug && console.warn("[DuplicatePostPreventer] Request blocked by built-in cooldown.");
				this.settings.isShowToasts && BdApi.UI.showToast("Please wait before checking another link!", { type: "error" });

				return Promise.resolve({ shouldNavigate: false });
			}
			this.lastSearchTime = currentTime;

			if (!this.startSearchingForDuplicate(channelId, postId)) {
				return Promise.resolve({ shouldNavigate: false });
			}

			const optimisticId = this.injectOptimisticMessage(content);
			const hasDuplicate = await this.waitForEndOfSearching();
			this.isBackgroundSearchingNow = false;

			if (hasDuplicate) {
				this.markOptimisticMessageBlocked(optimisticId);

				const shouldSend = await new Promise(resolve => {
					const timeoutId = setTimeout(() => resolve(false), 3000);

					this.showWarning(() => {
						clearTimeout(timeoutId);
						resolve(true);
					});
				});

				this.removeOptimisticMessage(optimisticId);
				this.removeWarning();

				if (!shouldSend) return Promise.resolve({ shouldNavigate: false });

				this.removeOptimisticMessage(optimisticId);
				return originalFunc.apply(instance, args);
			}

			this.removeOptimisticMessage(optimisticId);
			return originalFunc.apply(instance, args);
		});
	}

	startSearchingForDuplicate(channelId, postId) {
		this.settings.isDebug && console.log("[DuplicatePostPreventer] Starting duplicate search...");

		const guildId = this.selectedGuildStore.getGuildId();
		const channel = this.channelStoreModule.getChannel(channelId);

		if (!channel) {
			this.settings.isDebug && console.warn("[DuplicatePostPreventer] Channel not found:", channelId);
			return false;
		}

		const filterKey = this.langFilterMap?.FILTER_IN?.key || "in:";
		const channelName = typeof channel.name === "string" ? channel.name.trim() : null;
		const queryString = guildId && channelName ? `${filterKey} ${channelName} ${postId}` : `${postId}`;
		const searchContext = guildId
			? {
					type: "GUILD",
					guildId,
				}
			: {
					type: "CHANNEL",
					channelId,
				};
		this.currentSearchId = guildId || channelId;

		this.settings.isDebug &&
			console.log("[DuplicatePostPreventer] fetchMessages payload:", {
				searchContext,
				queryString,
			});

		this.isBackgroundSearchingNow = true;
		try {
			this.searchModule.fetchMessages({
				searchContext,
				searchQueryString: queryString,
				searchEverywhere: false,
				offset: 0,
			});
		} catch (error) {
			this.settings.isDebug && console.error("[DuplicatePostPreventer] unexpected error: ", error);
			this.isBackgroundSearchingNow = false;
			return false;
		}
		return true;
	}

	waitForEndOfSearching() {
		return new Promise(resolve => {
			const startTime = Date.now();

			const intervalId = setInterval(() => {
				try {
					const isFetching = this.searchMessageStore.getIsFetching(this.currentSearchId);

					if (!isFetching) {
						clearInterval(intervalId);

						const messages = this.searchMessageStore.getMessages(this.currentSearchId);
						this.settings.isDebug && console.log("[DuplicatePostPreventer] Search finished:", messages);
						resolve(Array.isArray(messages) && messages.length > 0);
						return;
					}

					if (Date.now() - startTime >= this.settings.waitingTimeMs) {
						clearInterval(intervalId);
						this.settings.isDebug && console.warn("[DuplicatePostPreventer] Search timeout reached");
						resolve(false);
					}
				} catch (error) {
					clearInterval(intervalId);
					this.settings.isDebug && console.error("[DuplicatePostPreventer] unexpected error: ", error);
					resolve(false);
				}
			}, 100);
		});
	}

	addStyles() {
		BdApi.DOM.addStyle(
			"DuplicatePostPreventer",
			`
				.dup-preventer-setting-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
				.dup-preventer-setting-row:last-child { margin-bottom: 0; }
				.dup-preventer-warning-container { background-color: var(--status-danger); color: #fff; padding: 8px 16px; border-radius: 8px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; font-size: 14px; font-family: var(--font-primary); font-weight: 500; box-shadow: var(--elevation-low); }
				.dup-preventer-control-box { width: 90px; height: 40px; box-sizing: border-box; }
				.dup-preventer-input { background-color: var(--background-floating, #111214); color: var(--text-normal); border: 1px solid transparent; border-radius: 4px; padding: 0 10px; text-align: center; font-family: inherit; font-size: 14px; outline: none; width: 100%; height: 100%; box-sizing: border-box; transition: border-color .15s ease; }
				.dup-preventer-input:focus { border-color: var(--brand-experiment, #5865F2); }
				.dup-preventer-input::-webkit-outer-spin-button, .dup-preventer-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
				.dup-preventer-input { -moz-appearance: textfield; }
				.dup-preventer-checkbox-wrapper { display: flex; align-items: center; justify-content: center; }
				.dup-preventer-switch { position: relative; display: inline-block; width: 40px; height: 22px; flex-shrink: 0; }
				.dup-preventer-switch input { opacity: 0; width: 0; height: 0; }
				.dup-preventer-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: var(--background-modifier-accent); transition: .15s ease; border-radius: 22px; }
				.dup-preventer-slider:before { position: absolute; content: ""; height: 16px; width: 16px; left: 3px; bottom: 3px; background-color: white; transition: .15s ease; border-radius: 50%; }
				input:checked + .dup-preventer-slider { background-color: var(--brand-experiment, #5865F2); }
				input:checked + .dup-preventer-slider:before { transform: translateX(18px); }
				.dup-preventer-optimistic-message { list-style: none; margin: 8px 16px; opacity: .55; animation: dup-preventer-fade-in .15s ease; }
				.dup-preventer-optimistic-content { max-width: 520px;	padding: 10px 14px;	border-radius: 12px;	background: var(--background-secondary);	border: 1px solid var(--background-modifier-accent); }
				.dup-preventer-optimistic-text { color: var(--text-normal); word-break: break-word; }
				.dup-preventer-optimistic-status { margin-top: 4px; font-size: 12px; color: var(--text-muted); }
				.dup-preventer-optimistic-blocked { opacity: .9; }
				.dup-preventer-optimistic-blocked
				.dup-preventer-optimistic-content { background: rgba(240, 71, 71, 0.15); border-color: rgba(240, 71, 71, 0.5); }
				@keyframes dup-preventer-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: .55; transform: translateY(0); } }
				.dup-preventer-status-container { display: flex; align-items: center; gap: 6px; margin-top: 4px; font-size: 12px; color: var(--text-muted); }
				.dup-preventer-spinner { width: 10px; height: 10px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; flex-shrink: 0; animation: dup-preventer-spin .8s linear infinite; }
				@keyframes dup-preventer-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
				.dup-preventer-blocked-message { opacity: .85; }
				.dup-preventer-blocked-message .dup-preventer-pending-status { color: var(--status-danger); font-weight: 500; }
				.dup-preventer-block-icon { flex-shrink: 0; }
			`,
		);
	}

	injectOptimisticMessage(content) {
		const messagesList = document.querySelector('[data-list-id="chat-messages"]');
		if (!messagesList) {
			this.settings.isDebug && console.warn("[DuplicatePostPreventer] Messages list not found");
			return null;
		}
		const messages = [...messagesList.children].reverse();

		const template =
			messages.find(node => node instanceof HTMLElement && node.matches("li") && node.querySelector("[id^='message-content-']")) ??
			messages[0];

		if (!template) {
			this.settings.isDebug && console.warn("[DuplicatePostPreventer] Failed to find message template");
			return null;
		}

		const optimisticId = `dup-preventer-${Date.now()}`;

		const clone = template.cloneNode(true);
		clone.dataset.optimisticId = optimisticId;
		clone.dataset.optimisticMessage = "true";
		clone.dataset.isSelf = "true";
		clone.classList.add("dup-preventer-optimistic-message");
		clone.removeAttribute("id");
		clone.removeAttribute("data-author-id");
		clone.querySelectorAll("[class*='reaction']").forEach(el => {
			el.remove();
		});
		clone.querySelectorAll("[class*='embed']").forEach(el => {
			el.remove();
		});
		clone.querySelectorAll("[class*='repliedMessage']").forEach(el => {
			el.remove();
		});
		clone.querySelectorAll("[id^='message-accessories']").forEach(el => {
			el.remove();
		});
		clone.querySelectorAll("[id]").forEach(el => {
			el.removeAttribute("id");
		});
		clone.querySelectorAll("[aria-labelledby]").forEach(el => {
			el.removeAttribute("aria-labelledby");
		});
		const buttonContainer = clone.querySelector("[class*='buttonContainer'");
		if (buttonContainer) buttonContainer.remove();
		let contentNode = clone.querySelector("[class*='messageContent']");
		if (!contentNode) {
			const contentsContainer = clone.querySelector("[class*='contents']");
			if (!contentsContainer) {
				this.settings.isDebug && console.warn("[DuplicatePostPreventer] Failed to create content container");
				return null;
			}
			contentNode = document.createElement("div");
			contentsContainer.appendChild(contentNode);
			this.settings.isDebug && console.log("[DuplicatePostPreventer] Created fallback message-content node");
		}
		contentNode.textContent = "";
		contentNode.textContent = content;

		const statusContainer = document.createElement("div");
		statusContainer.className = "dup-preventer-status-container";

		statusContainer.innerHTML = `
			<span class="dup-preventer-spinner"></span>
			<span class="dup-preventer-pending-status">
				Checking for duplicates...
			</span>
		`;
		contentNode.insertAdjacentElement("afterend", statusContainer);

		messagesList.insertBefore(clone, messagesList.lastElementChild);
		clone.scrollIntoView({
			block: "end",
			behavior: "smooth",
		});
		this.optimisticMessages.set(optimisticId, clone);
		return optimisticId;
	}

	markOptimisticMessageBlocked(optimisticId) {
		const node = this.optimisticMessages.get(optimisticId);
		if (!node) return;

		node.classList.remove("dup-preventer-optimistic-message");
		node.classList.add("dup-preventer-blocked-message");

		const statusContainer = node.querySelector(".dup-preventer-status-container");
		if (!statusContainer) return;

		statusContainer.innerHTML = `
			<span class="dup-preventer-block-icon">⚠️</span>
			<span class="dup-preventer-pending-status">
				Duplicate detected
			</span>
		`;
	}

	removeOptimisticMessage(optimisticId) {
		const node = this.optimisticMessages.get(optimisticId);
		if (node?.isConnected) node.remove();
		this.optimisticMessages.delete(optimisticId);
	}

	removeAllOptimisticMessages() {
		this.optimisticMessages.forEach(node => {
			if (node?.isConnected) node.remove();
		});
		this.optimisticMessages.clear();
	}

	showWarning(onForceSubmit) {
		if (document.getElementById("dup-preventer-warning")) return;

		const chatForm = document.querySelector("form[class*='form_']");
		if (!chatForm) return;

		const warningDiv = document.createElement("div");
		warningDiv.id = "dup-preventer-warning";
		warningDiv.className = "dup-preventer-warning-container";

		warningDiv.innerHTML = `
			<span>⚠️ A post with this ID has already been sent to this channel!</span>
			<div style="display: flex; gap: 10px; align-items: center;">
				<button class="dup-preventer-submit-btn" style="background: rgba(255,255,255,0.2); border: none; color: white; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 12px;">Send anyway</button>
				<button class="dup-preventer-close-btn" style="background: none; border: none; color: white; cursor: pointer; font-size: 14px;">✕</button>
			</div>
		`;

		warningDiv.querySelector(".dup-preventer-submit-btn").onclick = e => {
			e.preventDefault();
			onForceSubmit();
		};
		warningDiv.querySelector(".dup-preventer-close-btn").onclick = e => {
			e.preventDefault();
			this.removeWarning();
		};

		chatForm.prepend(warningDiv);
	}

	removeWarning() {
		const existingWarning = document.getElementById("dup-preventer-warning");
		if (existingWarning) existingWarning.remove();
	}

	getSettingsPanel() {
		const panel = document.createElement("div");
		panel.style =
			"padding: 16px; color: var(--text-normal); font-family: var(--font-primary); background: var(--background-secondary); border-radius: 8px;";

		this.settings = { cooldownMs: 3000, waitingTimeMs: 3000, isDebug: false, isShowToasts: true, ...this.settings };
		const s = this.settings;

		panel.innerHTML = `
			<div class="dup-preventer-setting-row">
				<span>Cooldown interval (500 - 10000 ms):</span>
				<div class="dup-preventer-control-box">
					<input type="number" class="dup-preventer-input" data-key="cooldownMs" min="500" max="10000">
				</div>
			</div>
			<div class="dup-preventer-setting-row">
				<span>Waiting time (500 - 10000 ms):</span>
				<div class="dup-preventer-control-box">
					<input type="number" class="dup-preventer-input" data-key="waitingTimeMs" min="500" max="10000">
				</div>
			</div>
			<div class="dup-preventer-setting-row">
				<span>Debug mode:</span>
				<div class="dup-preventer-control-box dup-preventer-checkbox-wrapper">
					<label class="dup-preventer-switch">
						<input type="checkbox" data-key="isDebug">
						<span class="dup-preventer-slider"></span>
					</label>
				</div>
			</div>
			<div class="dup-preventer-setting-row">
				<span>Show toasts:</span>
				<div class="dup-preventer-control-box dup-preventer-checkbox-wrapper">
					<label class="dup-preventer-switch">
						<input type="checkbox" data-key="isShowToasts">
						<span class="dup-preventer-slider"></span>
					</label>
				</div>
			</div>
		`;

		for (const input of panel.querySelectorAll("[data-key]")) {
			const key = input.dataset.key;
			if (input.type === "checkbox") {
				input.checked = !!s[key];
			} else {
				input.value = s[key];
			}
		}

		panel.addEventListener("change", e => {
			const target = e.target;
			const key = target.dataset.key;
			if (!key) return;

			if (target.type === "checkbox") {
				this.settings[key] = target.checked;
			} else {
				let val = parseInt(target.value, 10);
				val = Number.isNaN(val) ? 3000 : Math.max(500, Math.min(val, 10000));

				target.value = val;
				this.settings[key] = val;
			}

			BdApi.Data.save("DuplicatePostPreventer", "settings", this.settings);
		});

		return panel;
	}
};
