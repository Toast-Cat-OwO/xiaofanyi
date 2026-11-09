import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const MODULE_NAME = "xiaofanyi";

const DEFAULT_PROMPT = `You are a professional translator assisting in a fictional roleplay. 
Translate the user's input from {{source_lang}} to {{target_lang}}.
Tone/Style requirement: {{tone}}.
Output ONLY the translated text without quotes, explanations, or extra notes.`;

const DEFAULT_SETTINGS = {
    enable_ball: true,
    enable_selection: true,
    engine: "google",
    bilingual_format: "{{target}}（{{source}}）",
    api_url: "https://api.openai.com/v1/chat/completions",
    api_key: "",
    model: "gpt-4o-mini",
    prompt: DEFAULT_PROMPT,
    source_lang: "zh-CN",
    target_lang: "ko",
    tone: "Polite / Honorific (敬语)",
    ball_pos: { top: 220, left: window.innerWidth - 42, docked: "right" }
};

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    for (const key in DEFAULT_SETTINGS) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = DEFAULT_SETTINGS[key];
        }
    }
    return extension_settings[MODULE_NAME];
}

// 翻译核心函数
async function translateText(text, sourceLang, targetLang, tone = "Natural") {
    const settings = getSettings();
    if (!text.trim()) return "";

    if (settings.engine === "custom_ai" && settings.api_key) {
        const sysPrompt = (settings.prompt || DEFAULT_PROMPT)
            .replace(/\{\{source_lang\}\}/g, sourceLang)
            .replace(/\{\{target_lang\}\}/g, targetLang)
            .replace(/\{\{tone\}\}/g, tone);

        const response = await fetch(settings.api_url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${settings.api_key}`
            },
            body: JSON.stringify({
                model: settings.model,
                messages: [
                    { role: "system", content: sysPrompt },
                    { role: "user", content: text }
                ],
                temperature: 0.3
            })
        });

        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }
        const data = await response.json();
        return data.choices?.[0]?.message?.content?.trim() || "";
    } else {
        // 默认免费 Google 接口
        const sl = sourceLang === "auto" ? "auto" : sourceLang;
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP Error: ${response.status}`);
        }
        const data = await response.json();
        return data[0].map(item => item[0]).join("");
    }
}

// 将文本插入酒馆输入框 #send_textarea
function insertToChatInput(content, overwrite = false) {
    const textarea = document.getElementById("send_textarea");
    if (!textarea) return;

    if (overwrite) {
        textarea.value = content;
    } else {
        const start = textarea.selectionStart ?? textarea.value.length;
        const end = textarea.selectionEnd ?? textarea.value.length;
        const before = textarea.value.substring(0, start);
        const after = textarea.value.substring(end);
        textarea.value = before + content + after;
        const newPos = start + content.length;
        textarea.setSelectionRange(newPos, newPos);
    }
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
}

// 构建悬浮球与翻译面板 DOM
function buildFloatingUI() {
    const settings = getSettings();

    // 1. 悬浮球
    const ball = document.createElement("div");
    ball.id = "st-trans-ball";
    ball.textContent = "译";
    if (!settings.enable_ball) ball.style.display = "none";
    document.body.appendChild(ball);

    // 2. 主翻译面板
    const panel = document.createElement("div");
    panel.id = "st-trans-panel";
    panel.innerHTML = `
        <div class="kr-panel-header">
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

    // 同步保存的语言设置
    const srcSelect = document.getElementById("kr-source-lang");
    const tgtSelect = document.getElementById("kr-target-lang");
    const toneSelect = document.getElementById("kr-tone-select");
    srcSelect.value = settings.source_lang;
    tgtSelect.value = settings.target_lang;
    toneSelect.value = settings.tone;

    srcSelect.addEventListener("change", () => { settings.source_lang = srcSelect.value; saveSettingsDebounced(); });
    tgtSelect.addEventListener("change", () => { settings.target_lang = tgtSelect.value; saveSettingsDebounced(); });
    toneSelect.addEventListener("change", () => { settings.tone = toneSelect.value; saveSettingsDebounced(); });

    document.getElementById("kr-swap-lang").addEventListener("click", () => {
        if (srcSelect.value === "auto") return;
        const temp = srcSelect.value;
        srcSelect.value = tgtSelect.value;
        tgtSelect.value = temp;
        settings.source_lang = srcSelect.value;
        settings.target_lang = tgtSelect.value;
        saveSettingsDebounced();
    });

    // 执行翻译
    const btnTranslate = document.getElementById("kr-do-translate");
    const inputArea = document.getElementById("kr-input-text");
    const outputArea = document.getElementById("kr-output-text");

    btnTranslate.addEventListener("click", async () => {
        const srcText = inputArea.value.trim();
        if (!srcText) return;
        btnTranslate.textContent = "翻译中...";
        btnTranslate.disabled = true;
        try {
            const res = await translateText(srcText, srcSelect.value, tgtSelect.value, toneSelect.value);
            outputArea.value = res;
        } catch (err) {
            outputArea.value = `翻译出错: ${err.message}`;
        } finally {
            btnTranslate.textContent = "翻译";
            btnTranslate.disabled = false;
        }
    });

    // 三种追加方式
    document.getElementById("kr-insert-single").addEventListener("click", () => {
        const target = outputArea.value.trim();
        if (target) insertToChatInput(target, false);
    });

    document.getElementById("kr-insert-bilingual").addEventListener("click", () => {
        const source = inputArea.value.trim();
        const target = outputArea.value.trim();
        if (!target) return;
        const format = settings.bilingual_format || "{{target}}（{{source}}）";
        const formatted = format.replace(/\{\{target\}\}/g, target).replace(/\{\{source\}\}/g, source);
        insertToChatInput(formatted, false);
    });

    document.getElementById("kr-insert-overwrite").addEventListener("click", () => {
        const target = outputArea.value.trim();
        if (target) insertToChatInput(target, true);
    });

    document.getElementById("kr-panel-close").addEventListener("click", () => {
        panel.style.display = "none";
    });

    // 初始化悬浮球位置与拖拽事件
    initBallDragAndDock(ball, panel);
}

// 悬浮球拖拽与贴边吸附算法
function initBallDragAndDock(ball, panel) {
    const settings = getSettings();
    let isDragging = false;
    let startX = 0, startY = 0;
    let initialLeft = settings.ball_pos?.left ?? (window.innerWidth - 42);
    let initialTop = settings.ball_pos?.top ?? 220;

    function applyBallPosition(left, top, docked) {
        const maxTop = window.innerHeight - 48;
        const clampedTop = Math.max(10, Math.min(top, maxTop));
        ball.style.top = `${clampedTop}px`;
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

    applyBallPosition(initialLeft, initialTop, settings.ball_pos?.docked);

    ball.addEventListener("pointerdown", (e) => {
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = ball.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        ball.classList.remove("docked-left", "docked-right");
        ball.style.transition = "none";
        ball.setPointerCapture(e.pointerId);
    });

    ball.addEventListener("pointermove", (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        ball.style.left = `${initialLeft + dx}px`;
        ball.style.top = `${initialTop + dy}px`;
    });

    ball.addEventListener("pointerup", (e) => {
        if (!isDragging) return;
        isDragging = false;
        ball.style.transition = "";
        ball.releasePointerCapture(e.pointerId);

        const moveDist = Math.hypot(e.clientX - startX, e.clientY - startY);
        const rect = ball.getBoundingClientRect();

        // 位移小于 5px 视为点击，展开/收起面板
        if (moveDist < 5) {
            togglePanelNearBall(ball, panel);
            applyBallPosition(rect.left, rect.top, settings.ball_pos?.docked);
            return;
        }

        // 判断是否贴边吸附
        let docked = null;
        let finalLeft = rect.left;
        if (rect.left < 40) {
            docked = "left";
            finalLeft = 0;
        } else if (window.innerWidth - rect.right < 40) {
            docked = "right";
            finalLeft = window.innerWidth - 42;
        }

        settings.ball_pos = { left: finalLeft, top: rect.top, docked };
        saveSettingsDebounced();
        applyBallPosition(finalLeft, rect.top, docked);
    });
}

function togglePanelNearBall(ball, panel) {
    if (panel.style.display === "flex") {
        panel.style.display = "none";
        return;
    }
    panel.style.display = "flex";
    const ballRect = ball.getBoundingClientRect();
    const panelWidth = 340;
    const panelHeight = panel.offsetHeight || 320;

    let left = ballRect.left > window.innerWidth / 2
        ? ballRect.left - panelWidth - 12
        : ballRect.right + 12;

    left = Math.max(12, Math.min(left, window.innerWidth - panelWidth - 12));
    let top = Math.max(12, Math.min(ballRect.top, window.innerHeight - panelHeight - 12));

    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
}

// 划词翻译气泡构建
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
        const settings = getSettings();
        if (!settings.enable_selection) return;
        if (trigger.contains(e.target) || popover.contains(e.target)) return;

        setTimeout(() => {
            const selection = window.getSelection();
            const text = selection.toString().trim();
            const chatContainer = document.getElementById("chat");

            // 仅在聊天正文区域划词时触发
            if (text && chatContainer && chatContainer.contains(selection.anchorNode)) {
                selectedText = text;
                const range = selection.getRangeAt(0);
                const rect = range.getBoundingClientRect();
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

        let left = Math.max(12, Math.min(rect.left + window.scrollX - 100, window.innerWidth - 295));
        popover.style.left = `${left}px`;
        popover.style.top = `${rect.bottom + window.scrollY + 8}px`;

        try {
            // 正文划词默认翻译成中文 (zh-CN)
            const res = await translateText(selectedText, "auto", "zh-CN", "Natural");
            contentEl.textContent = res;
        } catch (err) {
            contentEl.textContent = `Error: ${err.message}`;
        }
    });

    document.getElementById("kr-popover-copy-btn").addEventListener("click", () => {
        const text = document.getElementById("kr-popover-content").textContent;
        navigator.clipboard.writeText(text);
        const btn = document.getElementById("kr-popover-copy-btn");
        btn.textContent = "Copied";
        setTimeout(() => (btn.textContent = "Copy"), 1200);
    });
}

// 初始化设置界面绑定
async function initSettingsUI() {
    const settingsHtml = await $.get(`scripts/extensions/third-party/${MODULE_NAME}/settings.html`);
    $("#extensions_settings").append(settingsHtml);

    const settings = getSettings();

    const elBall = $("#st_trans_enable_ball");
    const elSel = $("#st_trans_enable_selection");
    const elEngine = $("#st_trans_engine");
    const elFormat = $("#st_trans_bilingual_format");
    const elAiBox = $("#st_trans_ai_config");
    const elUrl = $("#st_trans_api_url");
    const elKey = $("#st_trans_api_key");
    const elModel = $("#st_trans_model");
    const elPrompt = $("#st_trans_prompt");

    elBall.prop("checked", settings.enable_ball);
    elSel.prop("checked", settings.enable_selection);
    elEngine.val(settings.engine);
    elFormat.val(settings.bilingual_format);
    elUrl.val(settings.api_url);
    elKey.val(settings.api_key);
    elModel.val(settings.model);
    elPrompt.val(settings.prompt);

    if (settings.engine === "custom_ai") elAiBox.show();

    elBall.on("change", function () {
        settings.enable_ball = $(this).is(":checked");
        $("#st-trans-ball").toggle(settings.enable_ball);
        saveSettingsDebounced();
    });

    elSel.on("change", function () {
        settings.enable_selection = $(this).is(":checked");
        saveSettingsDebounced();
    });

    elEngine.on("change", function () {
        settings.engine = $(this).val();
        elAiBox.toggle(settings.engine === "custom_ai");
        saveSettingsDebounced();
    });

    elFormat.on("input", function () {
        settings.bilingual_format = $(this).val();
        saveSettingsDebounced();
    });

    elUrl.on("input", function () { settings.api_url = $(this).val(); saveSettingsDebounced(); });
    elKey.on("input", function () { settings.api_key = $(this).val(); saveSettingsDebounced(); });
    elModel.on("input", function () { settings.model = $(this).val(); saveSettingsDebounced(); });
    elPrompt.on("input", function () { settings.prompt = $(this).val(); saveSettingsDebounced(); });

    $("#st_trans_reset_prompt").on("click", function () {
        settings.prompt = DEFAULT_PROMPT;
        elPrompt.val(DEFAULT_PROMPT);
        saveSettingsDebounced();
    });
}

jQuery(async () => {
    await initSettingsUI();
    buildFloatingUI();
    buildSelectionPopover();
});
