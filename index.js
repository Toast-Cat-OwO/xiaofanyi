import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const MODULE_NAME = "xiaofanyi";

const DEFAULT_PROMPT = `You are a professional translator assisting in a fictional roleplay. 
Translate the user's input from {{source_lang}} to {{target_lang}}.
Tone/Style requirement: {{tone}}.
Output ONLY the translated text without quotes, explanations, or extra notes.`;

const DEFAULT_PROFILE = {
    name: "默认配置",
    engine: "google",
    api_url: "https://api.openai.com/v1",
    api_key: "",
    model: "gpt-4o-mini",
    prompt: DEFAULT_PROMPT
};

const DEFAULT_SETTINGS = {
    enable_ball: true,
    enable_selection: true,
    bilingual_format: "{{target}}（{{source}}）",
    source_lang: "zh-CN",
    target_lang: "ko",
    tone: "Polite / Honorific (敬语)",
    ball_pos: { top: 220, left: window.innerWidth - 42, docked: "right" },
    active_profile_index: 0,
    profiles: [DEFAULT_PROFILE]
};

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    }
    const s = extension_settings[MODULE_NAME];
    if (!s.profiles || s.profiles.length === 0) {
        s.profiles = [JSON.parse(JSON.stringify(DEFAULT_PROFILE))];
        s.active_profile_index = 0;
    }
    return s;
}

function getActiveProfile() {
    const s = getSettings();
    if (!s.profiles[s.active_profile_index]) {
        s.active_profile_index = 0;
    }
    return s.profiles[s.active_profile_index];
}

// 弹窗 Toast 提示
function showToast(message) {
    let toast = document.getElementById("st-trans-toast");
    if (!toast) {
        toast = document.createElement("div");
        toast.id = "st-trans-toast";
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 2500);
}

// 翻译核心
async function translateText(text, sourceLang, targetLang, tone = "Natural") {
    const s = getSettings();
    const profile = getActiveProfile();
    if (!text.trim()) return "";

    if (profile.engine === "custom_ai") {
        if (!profile.api_key) {
            showToast("请先在设置中填写 API Key");
            throw new Error("Missing API Key");
        }
        let endpoint = profile.api_url.trim().replace(/\/+$/, "");
        if (!endpoint.endsWith("/chat/completions")) {
            endpoint += endpoint.endsWith("/v1") ? "/chat/completions" : "/v1/chat/completions";
        }

        const sysPrompt = (profile.prompt || DEFAULT_PROMPT)
            .replace(/\{\{source_lang\}\}/g, sourceLang)
            .replace(/\{\{target_lang\}\}/g, targetLang)
            .replace(/\{\{tone\}\}/g, tone);

        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${profile.api_key}`
            },
            body: JSON.stringify({
                model: profile.model || "gpt-4o-mini",
                messages: [
                    { role: "system", content: sysPrompt },
                    { role: "user", content: text }
                ],
                temperature: 0.3
            })
        });

        if (!response.ok) {
            const errJson = await response.json().catch(() => ({}));
            throw new Error(errJson.error?.message || `API Error: ${response.status}`);
        }
        const data = await response.json();
        return data.choices?.[0]?.message?.content?.trim() || "";
    } else {
        const sl = sourceLang === "auto" ? "auto" : sourceLang;
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Google Translate Error: ${response.status}`);
        const data = await response.json();
        return data[0].map(item => item[0]).join("");
    }
}

// 插入输入框
function insertToChatInput(content, overwrite = false) {
    const textarea = document.getElementById("send_textarea");
    if (!textarea) return;

    if (overwrite) {
        textarea.value = content;
    } else {
        const start = textarea.selectionStart ?? textarea.value.length;
        const end = textarea.selectionEnd ?? textarea.value.length;
        textarea.value = textarea.value.substring(0, start) + content + textarea.value.substring(end);
        const newPos = start + content.length;
        textarea.setSelectionRange(newPos, newPos);
    }
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
}

// 构建 UI
function buildFloatingUI() {
    const s = getSettings();

    const ball = document.createElement("div");
    ball.id = "st-trans-ball";
    ball.textContent = "译";
    if (!s.enable_ball) ball.style.display = "none";
    document.body.appendChild(ball);

    const panel = document.createElement("div");
    panel.id = "st-trans-panel";
    panel.innerHTML = `
        <div class="kr-panel-header" id="kr-panel-drag-handle">
            <span class="kr-panel-title">小翻译</span>
            <button class="kr-close-btn" id="kr-panel-close">×</button>
        </div>
        <div class="kr-controls-row">
            <select class="kr-select" id="kr-source-lang">
                <option value="zh-CN">中文</option>
                <option value="ko">한국어 (韩语)</option>
                <option value="ja">日本語 (日语)</option>
                <option value="en">English (英语)</option>
                <option value="auto">Auto (自动)</option>
            </select>
            <button class="kr-swap-btn" id="kr-swap-lang">⇄</button>
            <select class="kr-select" id="kr-target-lang">
                <option value="ko">한국어 (韩语)</option>
                <option value="ja">日本語 (日语)</option>
                <option value="en">English (英语)</option>
                <option value="zh-CN">中文</option>
            </select>
        </div>
        <div class="kr-controls-row">
            <select class="kr-select" id="kr-tone-select">
                <option value="Polite / Honorific (敬语)">语气：敬语 / 礼貌</option>
                <option value="Casual / Intimate (平语/亲密)">语气：平语 / 亲密</option>
                <option value="Natural Spoken (自然口语)">语气：自然日常口语</option>
                <option value="Cold / Aloof (冷淡/克制)">语气：冷淡 / 克制</option>
            </select>
        </div>
        <textarea class="kr-textarea" id="kr-input-text" rows="3" placeholder="输入你想表达的内容..."></textarea>
        <div class="kr-action-bar">
            <button class="kr-btn kr-btn-primary" id="kr-do-translate">翻译</button>
        </div>
        <textarea class="kr-textarea" id="kr-output-text" rows="3" placeholder="译文预览（可直接修改）..."></textarea>
        <div class="kr-action-bar">
            <button class="kr-btn" id="kr-insert-single">追加译文</button>
            <button class="kr-btn" id="kr-insert-bilingual">双语追加</button>
            <button class="kr-btn" id="kr-insert-overwrite">覆盖</button>
        </div>
    `;
    document.body.appendChild(panel);

    // 绑定语言选择
    const srcSelect = document.getElementById("kr-source-lang");
    const tgtSelect = document.getElementById("kr-target-lang");
    const toneSelect = document.getElementById("kr-tone-select");
    srcSelect.value = s.source_lang;
    tgtSelect.value = s.target_lang;
    toneSelect.value = s.tone;

    srcSelect.addEventListener("change", () => { s.source_lang = srcSelect.value; saveSettingsDebounced(); });
    tgtSelect.addEventListener("change", () => { s.target_lang = tgtSelect.value; saveSettingsDebounced(); });
    toneSelect.addEventListener("change", () => { s.tone = toneSelect.value; saveSettingsDebounced(); });

    document.getElementById("kr-swap-lang").addEventListener("click", () => {
        if (srcSelect.value === "auto") return;
        const temp = srcSelect.value;
        srcSelect.value = tgtSelect.value;
        tgtSelect.value = temp;
        s.source_lang = srcSelect.value;
        s.target_lang = tgtSelect.value;
        saveSettingsDebounced();
    });

    const btnTranslate = document.getElementById("kr-do-translate");
    const inputArea = document.getElementById("kr-input-text");
    const outputArea = document.getElementById("kr-output-text");

    btnTranslate.addEventListener("click", async () => {
        const text = inputArea.value.trim();
        if (!text) return;
        btnTranslate.textContent = "翻译中...";
        btnTranslate.disabled = true;
        try {
            const res = await translateText(text, srcSelect.value, tgtSelect.value, toneSelect.value);
            outputArea.value = res;
        } catch (err) {
            outputArea.value = `错误: ${err.message}`;
            showToast(err.message);
        } finally {
            btnTranslate.textContent = "翻译";
            btnTranslate.disabled = false;
        }
    });

    document.getElementById("kr-insert-single").addEventListener("click", () => {
        if (outputArea.value.trim()) insertToChatInput(outputArea.value.trim(), false);
    });
    document.getElementById("kr-insert-bilingual").addEventListener("click", () => {
        const source = inputArea.value.trim();
        const target = outputArea.value.trim();
        if (!target) return;
        const format = s.bilingual_format || "{{target}}（{{source}}）";
        insertToChatInput(format.replace(/\{\{target\}\}/g, target).replace(/\{\{source\}\}/g, source), false);
    });
    document.getElementById("kr-insert-overwrite").addEventListener("click", () => {
        if (outputArea.value.trim()) insertToChatInput(outputArea.value.trim(), true);
    });
    document.getElementById("kr-panel-close").addEventListener("click", () => {
        panel.style.display = "none";
    });

    // 让翻译面板本身也能通过头部拖拽移动位置
    initPanelDrag(panel);

    // 悬浮球拖拽与磁吸
    initBallDragAndDock(ball, panel);

    // 监听键盘弹出（Visual Viewport 适配输入法遮挡）
    if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", () => {
            if (panel.style.display === "flex") {
                const rect = panel.getBoundingClientRect();
                if (rect.bottom > window.visualViewport.height) {
                    panel.style.top = `${Math.max(10, window.visualViewport.height - panel.offsetHeight - 20)}px`;
                }
            }
        });
    }
}

// 面板头部拖拽逻辑
function initPanelDrag(panel) {
    const handle = document.getElementById("kr-panel-drag-handle");
    let isDragging = false;
    let startX = 0, startY = 0;
    let initialLeft = 0, initialTop = 0;

    handle.addEventListener("pointerdown", (e) => {
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = panel.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener("pointermove", (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        panel.style.left = `${initialLeft + dx}px`;
        panel.style.top = `${initialTop + dy}px`;
    });

    handle.addEventListener("pointerup", (e) => {
        if (!isDragging) return;
        isDragging = false;
        handle.releasePointerCapture(e.pointerId);
    });
}

function initBallDragAndDock(ball, panel) {
    const s = getSettings();
    let isDragging = false;
    let startX = 0, startY = 0;
    let initialLeft = s.ball_pos?.left ?? (window.innerWidth - 42);
    let initialTop = s.ball_pos?.top ?? 220;

    function applyPos(left, top, docked) {
        ball.style.top = `${Math.max(10, Math.min(top, window.innerHeight - 48))}px`;
        ball.classList.remove("docked-left", "docked-right");
        if (docked === "left") {
            ball.style.left = "0px";
            ball.classList.add("docked-left");
        } else if (docked === "right") {
            ball.style.left = `${window.innerWidth - 42}px`;
            ball.classList.add("docked-right");
        } else {
            ball.style.left = `${left}px`;
        }
    }

    applyPos(initialLeft, initialTop, s.ball_pos?.docked);

    ball.addEventListener("pointerdown", (e) => {
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = ball.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        ball.classList.remove("docked-left", "docked-right");
        ball.setPointerCapture(e.pointerId);
    });

    ball.addEventListener("pointermove", (e) => {
        if (!isDragging) return;
        ball.style.left = `${initialLeft + (e.clientX - startX)}px`;
        ball.style.top = `${initialTop + (e.clientY - startY)}px`;
    });

    ball.addEventListener("pointerup", (e) => {
        if (!isDragging) return;
        isDragging = false;
        ball.releasePointerCapture(e.pointerId);

        const moveDist = Math.hypot(e.clientX - startX, e.clientY - startY);
        const rect = ball.getBoundingClientRect();

        if (moveDist < 5) {
            if (panel.style.display === "flex") {
                panel.style.display = "none";
            } else {
                panel.style.display = "flex";
                const pWidth = 340;
                let left = rect.left > window.innerWidth / 2 ? rect.left - pWidth - 12 : rect.right + 12;
                left = Math.max(12, Math.min(left, window.innerWidth - pWidth - 12));
                let top = Math.max(12, Math.min(rect.top, window.innerHeight - 350));
                panel.style.left = `${left}px`;
                panel.style.top = `${top}px`;
            }
            applyPos(rect.left, rect.top, s.ball_pos?.docked);
            return;
        }

        let docked = null;
        let finalLeft = rect.left;
        if (rect.left < 40) { docked = "left"; finalLeft = 0; }
        else if (window.innerWidth - rect.right < 40) { docked = "right"; finalLeft = window.innerWidth - 42; }

        s.ball_pos = { left: finalLeft, top: rect.top, docked };
        saveSettingsDebounced();
        applyPos(finalLeft, rect.top, docked);
    });
}

// 划词翻译
function buildSelectionPopover() {
    const trigger = document.createElement("div");
    trigger.id = "st-trans-trigger";
    trigger.textContent = "Translate";
    document.body.appendChild(trigger);

    const popover = document.createElement("div");
    popover.id = "st-trans-popover";
    popover.innerHTML = `
        <div class="kr-popover-meta">
            <span>Translation</span>
            <span class="kr-popover-copy" id="kr-popover-copy-btn">Copy</span>
        </div>
        <div class="kr-popover-body" id="kr-popover-content"></div>
    `;
    document.body.appendChild(popover);

    let selectedText = "";

    document.addEventListener("mouseup", (e) => {
        const s = getSettings();
        if (!s.enable_selection || trigger.contains(e.target) || popover.contains(e.target)) return;

        setTimeout(() => {
            const selection = window.getSelection();
            const text = selection.toString().trim();
            const chatContainer = document.getElementById("chat");

            if (text && chatContainer && chatContainer.contains(selection.anchorNode)) {
                selectedText = text;
                const rect = selection.getRangeAt(0).getBoundingClientRect();
                trigger.style.left = `${rect.right + window.scrollX - 30}px`;
                trigger.style.top = `${rect.top + window.scrollY - 34}px`;
                trigger.style.display = "block";
                popover.style.display = "none";
            } else {
                trigger.style.display = "none";
                popover.style.display = "none";
            }
        }, 10);
    });

    trigger.addEventListener("click", async (e) => {
        e.stopPropagation();
        const rect = trigger.getBoundingClientRect();
        trigger.style.display = "none";
        const contentEl = document.getElementById("kr-popover-content");
        contentEl.textContent = "Translating...";
        popover.style.display = "flex";
        popover.style.left = `${Math.max(12, Math.min(rect.left + window.scrollX - 100, window.innerWidth - 295))}px`;
        popover.style.top = `${rect.bottom + window.scrollY + 8}px`;

        try {
            contentEl.textContent = await translateText(selectedText, "auto", "zh-CN", "Natural");
        } catch (err) {
            contentEl.textContent = `Error: ${err.message}`;
        }
    });

    document.getElementById("kr-popover-copy-btn").addEventListener("click", () => {
        navigator.clipboard.writeText(document.getElementById("kr-popover-content").textContent);
        const btn = document.getElementById("kr-popover-copy-btn");
        btn.textContent = "Copied";
        setTimeout(() => btn.textContent = "Copy", 1200);
    });
}

// 设置界面与配置切换绑定
async function initSettingsUI() {
    const settingsHtml = await $.get(`scripts/extensions/third-party/${MODULE_NAME}/settings.html`);
    $("#extensions_settings").append(settingsHtml);

    const s = getSettings();

    const elBall = $("#st_trans_enable_ball");
    const elSel = $("#st_trans_enable_selection");
    const elEngine = $("#st_trans_engine");
    const elFormat = $("#st_trans_bilingual_format");
    const elAiBox = $("#st_trans_ai_config");
    const elUrl = $("#st_trans_api_url");
    const elKey = $("#st_trans_api_key");
    const elModel = $("#st_trans_model");
    const elModelSelect = $("#st_trans_model_select");
    const elPrompt = $("#st_trans_prompt");
    const elProfileSelect = $("#st_trans_profile_select");

    function renderProfiles() {
        elProfileSelect.empty();
        s.profiles.forEach((p, idx) => {
            elProfileSelect.append(`<option value="${idx}" ${idx === s.active_profile_index ? "selected" : ""}>${p.name}</option>`);
        });
    }

    function loadActiveProfileToUI() {
        const p = getActiveProfile();
        elEngine.val(p.engine);
        elUrl.val(p.api_url);
        elKey.val(p.api_key);
        elModel.val(p.model);
        elPrompt.val(p.prompt);
        elAiBox.toggle(p.engine === "custom_ai");
    }

    renderProfiles();
    loadActiveProfileToUI();

    elBall.prop("checked", s.enable_ball);
    elSel.prop("checked", s.enable_selection);
    elFormat.val(s.bilingual_format);

    elProfileSelect.on("change", function () {
        s.active_profile_index = parseInt($(this).val());
        loadActiveProfileToUI();
        saveSettingsDebounced();
    });

    $("#st_trans_add_profile").on("click", () => {
        const name = prompt("请输入新配置方案名称：", `配置 ${s.profiles.length + 1}`);
        if (!name) return;
        s.profiles.push({
            name,
            engine: "custom_ai",
            api_url: "https://api.openai.com/v1",
            api_key: "",
            model: "gpt-4o-mini",
            prompt: DEFAULT_PROMPT
        });
        s.active_profile_index = s.profiles.length - 1;
        renderProfiles();
        loadActiveProfileToUI();
        saveSettingsDebounced();
    });

    $("#st_trans_del_profile").on("click", () => {
        if (s.profiles.length <= 1) {
            showToast("至少保留一个配置方案");
            return;
        }
        if (confirm(`确定删除配置「${getActiveProfile().name}」吗？`)) {
            s.profiles.splice(s.active_profile_index, 1);
            s.active_profile_index = 0;
            renderProfiles();
            loadActiveProfileToUI();
            saveSettingsDebounced();
        }
    });

    elBall.on("change", function () {
        s.enable_ball = $(this).is(":checked");
        $("#st-trans-ball").toggle(s.enable_ball);
        saveSettingsDebounced();
    });
    elSel.on("change", function () { s.enable_selection = $(this).is(":checked"); saveSettingsDebounced(); });
    elFormat.on("input", function () { s.bilingual_format = $(this).val(); saveSettingsDebounced(); });

    elEngine.on("change", function () {
        const p = getActiveProfile();
        p.engine = $(this).val();
        elAiBox.toggle(p.engine === "custom_ai");
        saveSettingsDebounced();
    });

    elUrl.on("input", function () { getActiveProfile().api_url = $(this).val(); saveSettingsDebounced(); });
    elKey.on("input", function () { getActiveProfile().api_key = $(this).val(); saveSettingsDebounced(); });
    elModel.on("input", function () { getActiveProfile().model = $(this).val(); saveSettingsDebounced(); });
    elPrompt.on("input", function () { getActiveProfile().prompt = $(this).val(); saveSettingsDebounced(); });

    elModelSelect.on("change", function () {
        if ($(this).val()) {
            elModel.val($(this).val());
            getActiveProfile().model = $(this).val();
            saveSettingsDebounced();
        }
    });

    // 拉取模型列表逻辑
    $("#st_trans_fetch_models").on("click", async () => {
        const p = getActiveProfile();
        if (!p.api_key) {
            showToast("请先填写 API Key");
            return;
        }
        try {
            showToast("正在获取模型列表...");
            let endpoint = p.api_url.trim().replace(/\/+$/, "");
            if (!endpoint.endsWith("/models")) {
                endpoint += endpoint.endsWith("/v1") ? "/models" : "/v1/models";
            }
            const res = await fetch(endpoint, {
                headers: { "Authorization": `Bearer ${p.api_key}` }
            });
            if (!res.ok) throw new Error("获取失败，请检查 URL 或 Key");
            const data = await res.json();
            const models = data.data || data.models || [];
            if (models.length === 0) {
                showToast("未检测到可用模型，请手动输入");
                return;
            }
            elModelSelect.empty();
            elModelSelect.append(`<option value="">-- 请选择模型 --</option>`);
            models.forEach(m => {
                const id = m.id || m.name;
                elModelSelect.append(`<option value="${id}">${id}</option>`);
            });
            elModelSelect.show();
            showToast(`成功获取 ${models.length} 个模型`);
        } catch (err) {
            showToast(err.message);
        }
    });

    $("#st_trans_reset_prompt").on("click", function () {
        getActiveProfile().prompt = DEFAULT_PROMPT;
        elPrompt.val(DEFAULT_PROMPT);
        saveSettingsDebounced();
    });
}

jQuery(async () => {
    await initSettingsUI();
    buildFloatingUI();
    buildSelectionPopover();
});
