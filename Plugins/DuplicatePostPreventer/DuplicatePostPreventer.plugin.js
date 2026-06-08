/**
 * @name DuplicatePostPreventer
 * @author Happywezer
 * @description Block re-sharing posts from X/Pixiv
 * @version 1.0.0
 */

module.exports = class DuplicatePostPreventer {
	constructor() {
		this.settings = { cooldownMs: 3000, waitingTimeMs: 3000, isDebug: true, isShowToasts: true };
		this.lastSearchTime = 0;
		this.isBackgroundSearchActive = false;
	}

	start() {
		this.settings = { ...this.settings, ...BdApi.Data.load("DuplicatePostPreventer", "settings") };

		if (this.initializeModules()) {
			this.patchModulesForBackgroundSearching();
			this.overrideSendMessage();
			this.settings.isShowToasts && BdApi.UI.showToast("[DuplicatePostPreventer] Plugin activated successfully", { type: "success" });
		} else {
			this.settings.isShowToasts && BdApi.UI.showToast("[DuplicatePostPreventer] Required modules not found", { type: "error" });
			setTimeout(() => BdApi.Plugins.disable("DuplicatePostPreventer"), 300);
		}
	}

	stop() {
		this.removeWarning();
		BdApi.Patcher.unpatchAll("DuplicatePostPreventer");
	}

	initializeModules() {
		this.settings.isDebug && console.log("[DuplicatePostPreventer] Binding Discord modules...");

		this.fluxDispatcher = BdApi.Webpack.getModule(m => m.dispatch && m.subscribe, { searchExports: true });
		this.performSearchDispatcher = BdApi.Webpack.getModule(m => m.emitter?._events?.PERFORM_SEARCH, { searchExports: true });
		this.searchFetchModule = BdApi.Webpack.getAllByPrototypeKeys("fetch", "cancel", { searchExports: true }).find(m => !m.length);
		this.selectedGuildStore = BdApi.Webpack.getStore("SelectedGuildStore");
		this.selectedChannelStore = BdApi.Webpack.getStore("SelectedChannelStore");
		this.channelStoreModule = BdApi.Webpack.getByKeys("getChannel", "hasChannel");
		this.messageActionsModule = BdApi.Webpack.getByKeys("sendMessage", "editMessage");
		this.langFilterMap = BdApi.Webpack.getModule(m => typeof m.FILTER_IN === "object", { searchExports: true });

		const requiredModules = [
			this.fluxDispatcher,
			this.performSearchDispatcher,
			this.searchFetchModule,
			this.selectedGuildStore,
			this.selectedChannelStore,
			this.channelStoreModule,
			this.messageActionsModule,
			this.langFilterMap,
		];

		if (!requiredModules.every(m => m)) {
			this.settings.isDebug &&
				console.error("[DuplicatePostPreventer] Failed to find required Discord modules.", {
					hasFluxDispatcher: !!this.fluxDispatcher,
					hasPerformSearchDispatcher: !!this.performSearchDispatcher,
					hasSearchFetchModule: !!this.searchFetchModule,
					hasSelectedGuildStore: !!this.selectedGuildStore,
					hasSelectedChannelStore: !!this.selectedChannelStore,
					hasChannelStoreModule: !!this.channelStoreModule,
					hasMessageActionsModule: !!this.messageActionsModule,
					hasLangFilterMap: !!this.langFilterMap,
				});
			return false;
		}

		this.settings.isDebug && console.log("[DuplicatePostPreventer] All modules successfully bound.");
		return true;
	}

	patchModulesForBackgroundSearching() {
		BdApi.Patcher.instead("DuplicatePostPreventer", this.fluxDispatcher, "dispatch", (instance, args, originalFunc) => {
			const [action] = args;
			if (action && typeof action.type === "string" && action.type === "SEARCH_MESSAGES_SUCCESS" && this.isBackgroundSearchActive) {
				this.isBackgroundSearchActive = false;
				this.fluxDispatcher.dispatch({ type: "[DuplicatePostPreventer]", messages: action?.data?.[0]?.messages });
				return Promise.resolve();
			}
			return originalFunc.apply(instance, args);
		});

		BdApi.Patcher.instead("DuplicatePostPreventer", this.searchFetchModule.prototype, "cancel", (instance, args, originalFunc) => {
			if (this.isBackgroundSearchActive) {
				return undefined;
			}
			return originalFunc.apply(instance, args);
		});
	}

	getPostId(content) {
		if (!content) return undefined;
		const regexsArray = [/status\/(\d+)/i, /artworks\/(\d+)/i, /shorts\/([a-zA-Z0-9_-]+)/i, /p\/([a-zA-Z0-9_-]+)/i];
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

			const hasDuplicate = await this.waitForEndOfSearching();

			if (hasDuplicate) {
				this.showWarning(() => {
					originalFunc.apply(instance, args);
					this.removeWarning();
				});
				return Promise.resolve({ shouldNavigate: false });
			}

			return originalFunc.apply(instance, args);
		});
	}

	startSearchingForDuplicate(channelId, postId) {
		this.settings.isShowToasts && BdApi.UI.showToast("Checking link for duplicates...", { type: "info" });
		this.settings.isDebug && console.log("[DuplicatePostPreventer] searching for duplicates...");

		const guildId = this.selectedGuildStore.getGuildId();
		const channel = this.channelStoreModule.getChannel(channelId);
		if (!channel) return false;

		const queryString = guildId ? `${this.langFilterMap?.FILTER_IN?.key || "in:"} ${channel.name} ${postId}` : `${postId}`;
		this.performSearchDispatcher.dispatch("PERFORM_SEARCH", {
			queryString: queryString,
			searchQuerySource: "search_text_input",
		});
		this.isBackgroundSearchActive = true;

		this.settings.isDebug && console.log(`[DuplicatePostPreventer] PERFORM_SEARCH flux action dispatched with '${queryString}'`);
		return true;
	}

	waitForEndOfSearching() {
		return new Promise(resolve => {
			let timeoutId = null;

			const cleanUp = () => {
				if (timeoutId) clearTimeout(timeoutId);
				this.fluxDispatcher.unsubscribe("[DuplicatePostPreventer]", handleSearchSuccess);
				this.fluxDispatcher.unsubscribe("SEARCH_MESSAGES_FAILURE", handleSearchFailure);
				this.isBackgroundSearchActive = false;
			};

			const handleSearchSuccess = event => {
				this.settings.isDebug && console.log("[DuplicatePostPreventer] SEARCH_MESSAGES_SUCCESS received", event);
				cleanUp();

				const hasMessages = event.messages && event.messages.length > 0;
				resolve(hasMessages);
			};

			const handleSearchFailure = event => {
				this.settings.isDebug && console.error("[DuplicatePostPreventer] SEARCH_MESSAGES_FAILURE received", event);
				cleanUp();
				resolve(false);
			};

			this.fluxDispatcher.subscribe("[DuplicatePostPreventer]", handleSearchSuccess);
			this.fluxDispatcher.subscribe("SEARCH_MESSAGES_FAILURE", handleSearchFailure);

			timeoutId = setTimeout(() => {
				this.settings.isDebug && console.warn("[DuplicatePostPreventer] Search timeout reached");
				cleanUp();
				resolve(false);
			}, this.settings.waitingTimeMs);
		});
	}

	showWarning(onForceSubmit) {
		this.removeWarning();
		const chatForm = document.querySelector("form[class*='form_']");
		if (!chatForm) return;

		const warningDiv = document.createElement("div");
		warningDiv.id = "dup-preventer-warning";
		warningDiv.style = `
            background-color: var(--status-danger);
            color: #fff;
            padding: 8px 16px;
            border-radius: 8px;
            margin-bottom: 8px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 14px;
            font-family: var(--font-primary);
            font-weight: 500;
            box-shadow: var(--elevation-low);
        `;

		const textSpan = document.createElement("span");
		textSpan.innerText = "⚠️ A post with this ID has already been sent to this channel!";

		const actionGroup = document.createElement("div");
		actionGroup.style = "display: flex; gap: 10px; align-items: center;";

		const submitBtn = document.createElement("button");
		submitBtn.innerText = "Send anyway";
		submitBtn.style =
			"background: rgba(255,255,255,0.2); border: none; color: white; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 12px;";
		submitBtn.onclick = e => {
			e.preventDefault();
			onForceSubmit();
		};

		const closeBtn = document.createElement("button");
		closeBtn.innerText = "✕";
		closeBtn.style = "background: none; border: none; color: white; cursor: pointer; font-size: 14px;";
		closeBtn.onclick = e => {
			e.preventDefault();
			this.removeWarning();
		};

		actionGroup.appendChild(submitBtn);
		actionGroup.appendChild(closeBtn);
		warningDiv.appendChild(textSpan);
		warningDiv.appendChild(actionGroup);

		chatForm.insertBefore(warningDiv, chatForm.firstChild);
	}

	removeWarning() {
		const existingWarning = document.getElementById("dup-preventer-warning");
		if (existingWarning) existingWarning.remove();
	}

	getSettingsPanel() {
		const panel = document.createElement("div");
		panel.style = "padding: 10px; color: var(--text-normal); font-family: var(--font-primary);";

		const title = document.createElement("h3");
		title.innerText = "DuplicatePostPreventer Settings";
		title.style.marginBottom = "15px";

		const settingRow = document.createElement("div");
		settingRow.style = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;";

		const label = document.createElement("span");
		label.innerText = "Search cooldown interval (in milliseconds):";

		const input = document.createElement("input");
		input.type = "number";
		input.value = this.settings.cooldownMs;
		input.style =
			"background: var(--background-tertiary); color: var(--text-normal); border: 1px solid var(--background-modifier-accent); padding: 5px; border-radius: 4px; width: 80px; text-align: center;";

		input.onchange = () => {
			let val = parseInt(input.value, 10);
			if (Number.isNaN(val) || val < 0) val = 0;
			this.settings.cooldownMs = val;
			BdApi.Data.save("DuplicatePostPreventer", "settings", this.settings);
		};

		settingRow.appendChild(label);
		settingRow.appendChild(input);
		panel.appendChild(title);
		panel.appendChild(settingRow);

		return panel;
	}
};
