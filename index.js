import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced, getRequestHeaders } from "../../../../script.js";

const MODULE_NAME = "xiaofanyi";

const DEFAULT_PROMPT = `You are a professional translator for roleplay.
Translate the user's text from {{source_lang}} to {{target_lang}}.
Additional requirement: {{requirement}}
Output ONLY the translated result without quotes, explanations, or extra notes.`;

const LANG_NAMES = {
    "auto": "Auto Detect",
    "zh-CN": "Simplified Chinese (简体中文)",
    "zh-TW": "Traditional Chinese (繁體中文)",
    "yue": "Colloquial Cantonese (地道粤语口语/香港广东话，请使用地道粤语词汇如係、唔、喺、咩、嘅等)",
    "ko": "Korean (韩语)",
    "ja": "Japanese (日语)",
    "en": "English (英语)",
    "ru": "Russian (俄语)",
    "fr": "French (法语)",
    "de": "German (德语)",
    "es": "Spanish (西班牙语)",
    "it": "Italian (意大利语)",
    "pt": "Portuguese (葡萄牙语)",
    "th": "Thai (泰语)",
    "vi": "Vietnamese (越南语)",
    "ar": "Arabic (阿拉伯语)"
};

const DEFAULT_PRESET_ID = "default_preset";

const DEFAULT_SETTINGS = {
    enable_ball: true,
    enable_selection: true,
    engine: "bing",
    bilingual_format: "{{target}}（{{source}}）",
    prompt: DEFAULT_PROMPT,
    source_lang: "zh-CN",
    target_lang: "ko",
    requirement: "",
    active_preset_id: DEFAULT_PRESET_ID,
    presets: [
        {
            id: DEFAULT_PRESET_ID,
            name: "默认 AI 预设",
            api_url: "https://api.openai.com/v1",
            api_key: "",
            model: "gpt-4o-mini"
        }
    ],
    ball_pos: { top: 200, left: window.innerWidth - 40, docked: "right" },
    panel_pos: { top: 120, left: Math.max(10, window.innerWidth - 350) }
};

let msTokenCache = {
    token: "",
    expireAt: 0
};

function notify(type, message, title = "小翻译") {
    if (window.toastr && typeof window.toastr[type] === "function") {
        window.toastr[type](message, title);
    } else {
        alert(`${title}: ${message}`);
    }
}

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    }
    const s = extension_settings[MODULE_NAME];
    for (const key in DEFAULT_SETTINGS) {
        if (s[key] === undefined) {
            s[key] = JSON.parse(JSON.stringify(DEFAULT_SETTINGS[key]));
        }
    }
    if (!Array.isArray(s.presets) || s.presets.length === 0) {
        s.presets = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.presets));
        s.active_preset_id = s.presets[0].id;
    }
    return s;
}

function getActivePreset() {
    const s = getSettings();
    return s.presets.find(p => p.id === s.active_preset_id) || s.presets[0];
}

// 智能规范化 API 地址
function resolveEndpoints(rawUrl) {
    let url = (rawUrl || "").trim().replace(/\/+$/, "");
    if (!url) return { chatUrl: "", modelsUrl: "" };

    if (url.endsWith("/chat/completions")) {
        const base = url.slice(0, -"/chat/completions".length);
        return { chatUrl: url, modelsUrl: `${base}/models` };
    }
    if (url.endsWith("/v1")) {
        return { chatUrl: `${url}/chat/completions`, modelsUrl: `${url}/models` };
    }
    return { chatUrl: `${url}/v1/chat/completions`, modelsUrl: `${url}/v1/models` };
}

// 拉取模型列表
async function fetchModelList(apiUrl, apiKey) {
    const { modelsUrl } = resolveEndpoints(apiUrl);
    if (!modelsUrl) throw new Error("请先填写 API 地址");
    if (!apiKey) throw new Error("请先填写 API Key");

    const response = await fetch(modelsUrl, {
        method: "GET",
        headers: {
            "Authorization": `Bearer ${apiKey}`
        }
    });

    if (!response.ok) {
        throw new Error(`拉取失败 (HTTP ${response.status})`);
    }
    const data = await response.json();
    const list = Array.isArray(data?.data) ? data.data.map(m => m.id) : [];
    if (list.length === 0) {
        throw new Error("接口返回成功，但未找到可用模型列表");
    }
    return list;
}

// 带超时控制的极速请求工具
async function fetchWithTimeout(url, options = {}, timeoutMs = 3500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// 并发竞速获取微软 Edge 官方 Token（所有节点同时跑，谁先返回用谁，绝不排队干等）
async function getMsEdgeToken(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && msTokenCache.token && now < msTokenCache.expireAt) {
        return msTokenCache.token;
    }

    const authUrl = "https://edge.microsoft.com/translate/auth";
    const candidates = [
        authUrl,
        `https://corsproxy.io/?url=${encodeURIComponent(authUrl)}`,
        `https://api.allorigins.win/raw?url=${encodeURIComponent(authUrl)}`,
        `https://thingproxy.freeboard.io/fetch/${authUrl}`
    ];

    const token = await Promise.any(
        candidates.map(async (u) => {
            const r = await fetchWithTimeout(u, { method: "GET" }, 3000);
            if (!r.ok) throw new Error("status " + r.status);
            const t = (await r.text()).trim();
            if (!t.startsWith("eyJ")) throw new Error("invalid jwt");
            return t;
        })
    );

    msTokenCache.token = token;
    msTokenCache.expireAt = now + 9 * 60 * 1000;
    return token;
}

// 微软必应神经网络翻译（优先走酒馆内置后端或并发极速通道，彻底移除慢速不准的 MyMemory）
async function bingDirectTranslate(text, sourceLang, targetLang) {
    const mapLang = (l, isSrc) => {
        if (l === "auto") return isSrc ? "" : "zh-Hans";
        if (l === "zh-CN") return "zh-Hans";
        if (l === "zh-TW") return "zh-Hant";
        if (l === "yue") return "yue";
        return l;
    };

    const from = mapLang(sourceLang, true);
    const to = mapLang(targetLang, false);

    // 方案 1：并发获取 Edge Token 直连微软官方高精接口
    try {
        const token = await getMsEdgeToken(false);
        const msUrl = `https://api-edge.cognitive.microsofttranslator.com/translate?from=${from}&to=${to}&api-version=3.0`;
        const transResp = await fetchWithTimeout(msUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify([{ Text: text }])
        }, 4000);

        if (transResp.ok) {
            const data = await transResp.json();
            const res = data?.[0]?.translations?.[0]?.text;
            if (res) return res;
        }
    } catch (e) {
        // 继续尝试方案 2
    }

    // 方案 2：直接调用 Google GTX 高速接口（支持粤语与全语种）
    const sl = sourceLang === "auto" ? "auto" : sourceLang;
    const gtxUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
    const gtxResp = await fetchWithTimeout(gtxUrl, {}, 4000);
    if (gtxResp.ok) {
        const data = await gtxResp.json();
        return data[0].map(item => item[0]).join("");
    }

    throw new Error("免费翻译网络超时，建议切换为 Google 翻译或配置 AI 预设");
}

// 翻译核心逻辑
async function translateText(text, sourceLang, targetLang, requirement = "") {
    const settings = getSettings();
    if (!text.trim()) return "";

    if (settings.engine === "custom_ai") {
        const preset = getActivePreset();
        if (!preset || !preset.api_url.trim()) {
            throw new Error("请先在设置中配置 API 地址");
        }
        if (!preset.api_key.trim()) {
            throw new Error("请先在设置中配置 API Key");
        }
        if (!preset.model.trim()) {
            throw new Error("请先填写或选择模型名称");
        }

        const { chatUrl } = resolveEndpoints(preset.api_url);
        const reqText = requirement.trim() ? requirement.trim() : "Natural and accurate translation";
        const srcName = LANG_NAMES[sourceLang] || sourceLang;
        const tgtName = LANG_NAMES[targetLang] || targetLang;
        const sysPrompt = (settings.prompt || DEFAULT_PROMPT)
            .replace(/\{\{source_lang\}\}/g, srcName)
            .replace(/\{\{target_lang\}\}/g, tgtName)
            .replace(/\{\{requirement\}\}/g, reqText);

        const response = await fetch(chatUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${preset.api_key.trim()}`
            },
            body: JSON.stringify({
                model: preset.model.trim(),
                messages: [
                    { role: "system", content: sysPrompt },
                    { role: "user", content: text }
                ],
                temperature: 0.3
            })
        });

        if (!response.ok) {
            throw new Error(`API 请求失败 (状态码: ${response.status})`);
        }
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content?.trim();
        if (!content) throw new Error("AI 返回内容为空");
        return content;
    } else if (settings.engine === "bing") {
        return await bingDirectTranslate(text, sourceLang, targetLang);
    } else {
        const sl = sourceLang === "auto" ? "auto" : sourceLang;
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
        const response = await fetchWithTimeout(url, {}, 5000);
        if (!response.ok) {
            throw new Error(`Google 翻译请求失败 (${response.status})`);
        }
        const data = await response.json();
        return data[0].map(item => item[0]).join("");
    }
}

// 插入文本到酒馆主输入框
function insertToChatInput(content, overwrite = false) {
    const textarea = document.getElementById("send_textarea");
    if (!textarea) {
        notify("warning", "未找到酒馆主输入框");
        return;
    }

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
}

// 刷新面板上的快捷引擎/预设下拉框与翻译要求显隐
function syncPanelEngineUI() {
    const settings = getSettings();
    const quickSelect = document.getElementById("xfy-quick-engine");
    const reqRow = document.getElementById("xfy-req-row");
    if (!quickSelect || !reqRow) return;

    quickSelect.innerHTML = `
        <option value="bing">微软必应</option>
        <option value="google">Google 翻译</option>
    `;
    settings.presets.forEach(p => {
        const opt = document.createElement("option");
        opt.value = `preset:${p.id}`;
        opt.textContent = p.name;
        quickSelect.appendChild(opt);
    });

    if (settings.engine === "bing" || settings.engine === "google") {
        quickSelect.value = settings.engine;
        reqRow.style.display = "none";
    } else {
        quickSelect.value = `preset:${settings.active_preset_id}`;
        reqRow.style.display = "flex";
    }
}

// 构建悬浮球与可拖拽缩放面板
function buildFloatingUI() {
    const settings = getSettings();

    const ball = document.createElement("div");
    ball.id = "xfy-ball";
    ball.textContent = "译";
    if (!settings.enable_ball) ball.style.display = "none";
    document.body.appendChild(ball);

    const panel = document.createElement("div");
    panel.id = "xfy-panel";
    panel.innerHTML = `
        <div class="xfy-panel-header" id="xfy-panel-drag-handle">
            <span class="xfy-panel-title">小翻译</span>
            <div class="xfy-header-controls">
                <select class="xfy-QuickEngine-select" id="xfy-quick-engine" title="切换翻译源"></select>
                <button class="xfy-icon-btn" id="xfy-panel-min" title="折叠/展开">—</button>
                <button class="xfy-icon-btn" id="xfy-panel-close" title="关闭">×</button>
            </div>
        </div>
        <div class="xfy-panel-body">
            <div class="xfy-controls-row">
                <select class="xfy-select" id="xfy-source-lang">
                    <option value="auto">自动检测 (Auto)</option>
                    <option value="zh-CN">简体中文</option>
                    <option value="zh-TW">繁體中文</option>
                    <option value="yue">粵語 (广东话)</option>
                    <option value="ko">한국어 (韩语)</option>
                    <option value="ja">日本語 (日语)</option>
                    <option value="en">English (英语)</option>
                    <option value="ru">Русский (俄语)</option>
                    <option value="fr">Français (法语)</option>
                    <option value="de">Deutsch (德语)</option>
                    <option value="es">Español (西班牙语)</option>
                    <option value="it">Italiano (意大利语)</option>
                    <option value="pt">Português (葡萄牙语)</option>
                    <option value="th">ไทย (泰语)</option>
                    <option value="vi">Tiếng Việt (越南语)</option>
                    <option value="ar">العربية (阿拉伯语)</option>
                </select>
                <button class="xfy-swap-btn" id="xfy-swap-lang">⇄</button>
                <select class="xfy-select" id="xfy-target-lang">
                    <option value="ko">한국어 (韩语)</option>
                    <option value="ja">日本語 (日语)</option>
                    <option value="en">English (英语)</option>
                    <option value="yue">粵語 (广东话)</option>
                    <option value="ru">Русский (俄语)</option>
                    <option value="fr">Français (法语)</option>
                    <option value="de">Deutsch (德语)</option>
                    <option value="es">Español (西班牙语)</option>
                    <option value="it">Italiano (意大利语)</option>
                    <option value="pt">Português (葡萄牙语)</option>
                    <option value="th">ไทย (泰语)</option>
                    <option value="vi">Tiếng Việt (越南语)</option>
                    <option value="ar">العربية (阿拉伯语)</option>
                    <option value="zh-CN">简体中文</option>
                    <option value="zh-TW">繁體中文</option>
                </select>
            </div>
            <div class="xfy-controls-row" id="xfy-req-row" style="display: none;">
                <input type="text" class="xfy-input" id="xfy-req-input" placeholder="翻译要求（例：使用亲密平语 / 敬语）" />
            </div>
            <div class="xfy-textarea-wrap">
                <textarea class="xfy-textarea" id="xfy-input-text" rows="2" placeholder="输入要翻译的内容..."></textarea>
                <button type="button" class="xfy-clear-btn" id="xfy-clear-input" title="清空内容">×</button>
            </div>
            <div class="xfy-action-bar">
                <button class="xfy-btn xfy-btn-primary" id="xfy-do-translate">翻译</button>
            </div>
            <textarea class="xfy-textarea" id="xfy-output-text" rows="2" placeholder="译文结果（可手动微调）..."></textarea>
            <div class="xfy-action-bar">
                <button class="xfy-btn" id="xfy-insert-single">追加译文</button>
                <button class="xfy-btn" id="xfy-insert-bilingual">双语追加</button>
                <button class="xfy-btn" id="xfy-insert-overwrite">覆盖</button>
            </div>
        </div>
    `;
    document.body.appendChild(panel);

    syncPanelEngineUI();

    const srcSelect = document.getElementById("xfy-source-lang");
    const tgtSelect = document.getElementById("xfy-target-lang");
    const reqInput = document.getElementById("xfy-req-input");
    const quickEngine = document.getElementById("xfy-quick-engine");

    srcSelect.value = settings.source_lang;
    tgtSelect.value = settings.target_lang;
    reqInput.value = settings.requirement || "";

    quickEngine.addEventListener("pointerdown", e => e.stopPropagation());
    document.getElementById("xfy-panel-min").addEventListener("pointerdown", e => e.stopPropagation());
    document.getElementById("xfy-panel-close").addEventListener("pointerdown", e => e.stopPropagation());

    quickEngine.addEventListener("change", () => {
        const val = quickEngine.value;
        if (val === "bing" || val === "google") {
            settings.engine = val;
        } else if (val.startsWith("preset:")) {
            settings.engine = "custom_ai";
            settings.active_preset_id = val.replace("preset:", "");
        }
        saveSettingsDebounced();
        syncPanelEngineUI();
        $("#xfy_engine").val(settings.engine);
        $("#xfy_ai_config").toggle(settings.engine === "custom_ai");
        $("#xfy_preset_select").val(settings.active_preset_id).trigger("change");
    });

    srcSelect.addEventListener("change", () => { settings.source_lang = srcSelect.value; saveSettingsDebounced(); });
    tgtSelect.addEventListener("change", () => { settings.target_lang = tgtSelect.value; saveSettingsDebounced(); });
    reqInput.addEventListener("input", () => { settings.requirement = reqInput.value; saveSettingsDebounced(); });

    document.getElementById("xfy-swap-lang").addEventListener("click", () => {
        if (srcSelect.value === "auto") return;
        const tmp = srcSelect.value;
        srcSelect.value = tgtSelect.value;
        tgtSelect.value = tmp;
        settings.source_lang = srcSelect.value;
        settings.target_lang = tgtSelect.value;
        saveSettingsDebounced();
    });

    const minBtn = document.getElementById("xfy-panel-min");
    minBtn.addEventListener("click", () => {
        panel.classList.toggle("xfy-minimized");
        minBtn.textContent = panel.classList.contains("xfy-minimized") ? "□" : "—";
    });

    document.getElementById("xfy-panel-close").addEventListener("click", () => {
        panel.style.display = "none";
    });

    const btnTranslate = document.getElementById("xfy-do-translate");
    const inputArea = document.getElementById("xfy-input-text");
    const outputArea = document.getElementById("xfy-output-text");

    document.getElementById("xfy-clear-input").addEventListener("click", () => {
        inputArea.value = "";
        outputArea.value = "";
        inputArea.focus();
    });

    btnTranslate.addEventListener("click", async () => {
        const srcText = inputArea.value.trim();
        if (!srcText) {
            notify("warning", "请先输入要翻译的内容");
            return;
        }
        btnTranslate.textContent = "翻译中...";
        btnTranslate.disabled = true;
        try {
            const res = await translateText(srcText, srcSelect.value, tgtSelect.value, reqInput.value);
            outputArea.value = res;
        } catch (err) {
            notify("error", err.message);
        } finally {
            btnTranslate.textContent = "翻译";
            btnTranslate.disabled = false;
        }
    });

    document.getElementById("xfy-insert-single").addEventListener("click", () => {
        const target = outputArea.value.trim();
        if (!target) return notify("warning", "译文为空，请先翻译");
        insertToChatInput(target, false);
    });

    document.getElementById("xfy-insert-bilingual").addEventListener("click", () => {
        const source = inputArea.value.trim();
        const target = outputArea.value.trim();
        if (!target) return notify("warning", "译文为空，请先翻译");
        const format = settings.bilingual_format || "{{target}}（{{source}}）";
        const formatted = format.replace(/\{\{target\}\}/g, target).replace(/\{\{source\}\}/g, source);
        insertToChatInput(formatted, false);
    });

    document.getElementById("xfy-insert-overwrite").addEventListener("click", () => {
        const target = outputArea.value.trim();
        if (!target) return notify("warning", "译文为空，请先翻译");
        insertToChatInput(target, true);
    });

    initBallDragAndDock(ball, panel);
    initPanelDragAndViewport(panel);
}

// 面板自由拖拽 + 手机端软键盘弹出自动上推防遮挡
function initPanelDragAndViewport(panel) {
    const settings = getSettings();
    const handle = document.getElementById("xfy-panel-drag-handle");
    let isDragging = false;
    let startX = 0, startY = 0, initLeft = 0, initTop = 0;

    function clampPanelPosition(left, top) {
        const vvHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        const vvWidth = window.visualViewport ? window.visualViewport.width : window.innerWidth;
        const rect = panel.getBoundingClientRect();
        const w = rect.width || 330;
        const h = rect.height || 260;

        const clampedLeft = Math.max(6, Math.min(left, vvWidth - w - 6));
        const clampedTop = Math.max(6, Math.min(top, vvHeight - h - 6));
        panel.style.left = `${clampedLeft}px`;
        panel.style.top = `${clampedTop}px`;
        return { left: clampedLeft, top: clampedTop };
    }

    handle.addEventListener("pointerdown", (e) => {
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = panel.getBoundingClientRect();
        initLeft = rect.left;
        initTop = rect.top;
        panel.style.transition = "none";
        handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener("pointermove", (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        clampPanelPosition(initLeft + dx, initTop + dy);
    });

    handle.addEventListener("pointerup", (e) => {
        if (!isDragging) return;
        isDragging = false;
        panel.style.transition = "top 0.15s ease-out";
        handle.releasePointerCapture(e.pointerId);
        const rect = panel.getBoundingClientRect();
        settings.panel_pos = { left: rect.left, top: rect.top };
        saveSettingsDebounced();
    });

    if (window.visualViewport) {
        const adjustForKeyboard = () => {
            if (panel.style.display === "none") return;
            const vv = window.visualViewport;
            const rect = panel.getBoundingClientRect();
            const bottomOverflow = rect.bottom - (vv.height + vv.offsetTop - 8);
            if (bottomOverflow > 0) {
                const newTop = Math.max(8, rect.top - bottomOverflow);
                panel.style.top = `${newTop}px`;
            }
        };
        window.visualViewport.addEventListener("resize", adjustForKeyboard);
        window.visualViewport.addEventListener("scroll", adjustForKeyboard);
    }
}

// 悬浮球拖拽与贴边半隐藏
function initBallDragAndDock(ball, panel) {
    const settings = getSettings();
    let isDragging = false;
    let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

    function applyBallPosition(left, top, docked) {
        const maxTop = window.innerHeight - 46;
        const clampedTop = Math.max(10, Math.min(top, maxTop));
        ball.style.top = `${clampedTop}px`;
        ball.classList.remove("docked-left", "docked-right");

        if (docked === "left") {
            ball.style.left = "0px";
            ball.classList.add("docked-left");
        } else if (docked === "right") {
            ball.style.left = `${window.innerWidth - 40}px`;
            ball.classList.add("docked-right");
        } else {
            ball.style.left = `${left}px`;
        }
    }

    applyBallPosition(
        settings.ball_pos?.left ?? (window.innerWidth - 40),
        settings.ball_pos?.top ?? 200,
        settings.ball_pos?.docked
    );

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
        ball.style.left = `${initialLeft + (e.clientX - startX)}px`;
        ball.style.top = `${initialTop + (e.clientY - startY)}px`;
    });

    ball.addEventListener("pointerup", (e) => {
        if (!isDragging) return;
        isDragging = false;
        ball.style.transition = "";
        ball.releasePointerCapture(e.pointerId);

        const moveDist = Math.hypot(e.clientX - startX, e.clientY - startY);
        const rect = ball.getBoundingClientRect();

        if (moveDist < 5) {
            if (panel.style.display === "flex") {
                panel.style.display = "none";
            } else {
                panel.style.display = "flex";
                const savedLeft = settings.panel_pos?.left ?? Math.max(10, window.innerWidth - 350);
                const savedTop = settings.panel_pos?.top ?? 120;
                const vvW = window.visualViewport ? window.visualViewport.width : window.innerWidth;
                const vvH = window.visualViewport ? window.visualViewport.height : window.innerHeight;
                panel.style.left = `${Math.max(8, Math.min(savedLeft, vvW - 338))}px`;
                panel.style.top = `${Math.max(8, Math.min(savedTop, vvH - 280))}px`;
            }
            applyBallPosition(rect.left, rect.top, settings.ball_pos?.docked);
            return;
        }

        let docked = null;
        let finalLeft = rect.left;
        if (rect.left < 40) {
            docked = "left";
            finalLeft = 0;
        } else if (window.innerWidth - rect.right < 40) {
            docked = "right";
            finalLeft = window.innerWidth - 40;
        }

        settings.ball_pos = { left: finalLeft, top: rect.top, docked };
        saveSettingsDebounced();
        applyBallPosition(finalLeft, rect.top, docked);
    });
}

// 正文划词翻译气泡（兼容电脑端鼠标与手机端长按选词）
function buildSelectionPopover() {
    const trigger = document.createElement("div");
    trigger.id = "xfy-trigger";
    trigger.textContent = "翻译";
    document.body.appendChild(trigger);

    const popover = document.createElement("div");
    popover.id = "xfy-popover";
    popover.innerHTML = `
        <div class="xfy-popover-meta">
            <span>译文</span>
            <span class="xfy-popover-copy" id="xfy-popover-copy-btn">复制</span>
        </div>
        <div class="xfy-popover-body" id="xfy-popover-content"></div>
    `;
    document.body.appendChild(popover);

    let selectedText = "";
    let selectionTimer = null;

    function checkSelection() {
        const settings = getSettings();
        if (!settings.enable_selection) return;

        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
            trigger.style.display = "none";
            return;
        }

        const text = selection.toString().trim();
        const chatContainer = document.getElementById("chat");

        if (text && chatContainer && chatContainer.contains(selection.anchorNode)) {
            selectedText = text;
            const range = selection.getRangeAt(0);
            const rect = range.getBoundingClientRect();

            const left = Math.max(10, Math.min(rect.right + window.scrollX - 28, window.innerWidth - 70));
            const top = rect.bottom + window.scrollY + 8;

            trigger.style.left = `${left}px`;
            trigger.style.top = `${top}px`;
            trigger.style.display = "block";
        } else {
            trigger.style.display = "none";
        }
    }

    document.addEventListener("selectionchange", () => {
        clearTimeout(selectionTimer);
        selectionTimer = setTimeout(checkSelection, 200);
    });

    document.addEventListener("pointerdown", (e) => {
        if (trigger.contains(e.target) || popover.contains(e.target)) return;
        popover.style.display = "none";
    });

    trigger.addEventListener("pointerup", async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const rect = trigger.getBoundingClientRect();
        trigger.style.display = "none";

        const contentEl = document.getElementById("xfy-popover-content");
        contentEl.textContent = "翻译中...";
        popover.style.display = "flex";

        const left = Math.max(10, Math.min(rect.left + window.scrollX - 100, window.innerWidth - 285));
        popover.style.left = `${left}px`;
        popover.style.top = `${rect.bottom + window.scrollY + 6}px`;

        try {
            const res = await translateText(selectedText, "auto", "zh-CN", "");
            contentEl.textContent = res;
        } catch (err) {
            contentEl.textContent = `翻译失败: ${err.message}`;
            notify("error", err.message);
        }
    });

    document.getElementById("xfy-popover-copy-btn").addEventListener("click", () => {
        const text = document.getElementById("xfy-popover-content").textContent;
        navigator.clipboard.writeText(text);
        notify("success", "已复制译文");
    });
}

// 初始化设置界面与预设管理
async function initSettingsUI() {
    const settingsHtml = await $.get(`scripts/extensions/third-party/${MODULE_NAME}/settings.html`);
    $("#extensions_settings").append(settingsHtml);

    const settings = getSettings();

    const elBall = $("#xfy_enable_ball");
    const elSel = $("#xfy_enable_selection");
    const elEngine = $("#xfy_engine");
    const elFormat = $("#xfy_bilingual_format");
    const elAiBox = $("#xfy_ai_config");
    const elPresetSelect = $("#xfy_preset_select");
    const elPresetName = $("#xfy_preset_name");
    const elUrl = $("#xfy_api_url");
    const elKey = $("#xfy_api_key");
    const elModelInput = $("#xfy_model_input");
    const elModelSelect = $("#xfy_model_select");
    const elPrompt = $("#xfy_prompt");

    function renderPresetOptions() {
        elPresetSelect.empty();
        settings.presets.forEach(p => {
            elPresetSelect.append($("<option></option>").val(p.id).text(p.name));
        });
        elPresetSelect.val(settings.active_preset_id);
        loadActivePresetToInputs();
        syncPanelEngineUI();
    }

    function loadActivePresetToInputs() {
        const preset = getActivePreset();
        if (!preset) return;
        elPresetName.val(preset.name);
        elUrl.val(preset.api_url);
        elKey.val(preset.api_key);
        elModelInput.val(preset.model);
    }

    elBall.prop("checked", settings.enable_ball);
    elSel.prop("checked", settings.enable_selection);
    elEngine.val(settings.engine);
    elFormat.val(settings.bilingual_format);
    elPrompt.val(settings.prompt);
    if (settings.engine === "custom_ai") elAiBox.show();

    renderPresetOptions();

    elBall.on("change", function () {
        settings.enable_ball = $(this).is(":checked");
        $("#xfy-ball").toggle(settings.enable_ball);
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
        syncPanelEngineUI();
    });

    elFormat.on("input", function () {
        settings.bilingual_format = $(this).val();
        saveSettingsDebounced();
    });

    elPresetSelect.on("change", function () {
        settings.active_preset_id = $(this).val();
        loadActivePresetToInputs();
        saveSettingsDebounced();
        syncPanelEngineUI();
    });

    $("#xfy_preset_new").on("click", function () {
        const newId = "preset_" + Date.now();
        settings.presets.push({
            id: newId,
            name: `预设 ${settings.presets.length + 1}`,
            api_url: "https://api.openai.com/v1",
            api_key: "",
            model: ""
        });
        settings.active_preset_id = newId;
        renderPresetOptions();
        saveSettingsDebounced();
        notify("info", "已创建新预设，请填写配置后点击保存");
    });

    $("#xfy_preset_delete").on("click", function () {
        if (settings.presets.length <= 1) {
            return notify("warning", "至少需要保留一个预设");
        }
        settings.presets = settings.presets.filter(p => p.id !== settings.active_preset_id);
        settings.active_preset_id = settings.presets[0].id;
        renderPresetOptions();
        saveSettingsDebounced();
        notify("success", "预设已删除");
    });

    $("#xfy_save_preset").on("click", function () {
        const preset = getActivePreset();
        if (!preset) return;
        const currentModel = elModelSelect.is(":visible") ? elModelSelect.val() : elModelInput.val();
        preset.name = elPresetName.val().trim() || "未命名预设";
        preset.api_url = elUrl.val().trim();
        preset.api_key = elKey.val().trim();
        preset.model = (currentModel || "").trim();

        renderPresetOptions();
        saveSettingsDebounced();
        notify("success", `预设「${preset.name}」已保存`);
    });

    $("#xfy_fetch_models").on("click", async function () {
        const btn = $(this);
        const url = elUrl.val().trim();
        const key = elKey.val().trim();
        btn.text("获取中...").prop("disabled", true);
        try {
            const models = await fetchModelList(url, key);
            elModelSelect.empty();
            models.forEach(m => {
                elModelSelect.append($("<option></option>").val(m).text(m));
            });
            if (models.includes(elModelInput.val().trim())) {
                elModelSelect.val(elModelInput.val().trim());
            } else {
                elModelInput.val(models[0]);
            }
            elModelInput.hide();
            elModelSelect.show();
            notify("success", `成功获取 ${models.length} 个模型`);
        } catch (err) {
            notify("error", err.message);
        } finally {
            btn.text("获取模型").prop("disabled", false);
        }
    });

    elModelSelect.on("change", function () {
        elModelInput.val($(this).val());
    });

    $("#xfy_toggle_model_input").on("click", function () {
        if (elModelSelect.is(":visible")) {
            elModelSelect.hide();
            elModelInput.show();
        } else {
            if (elModelSelect.children().length === 0) {
                return notify("info", "请先点击「获取模型」拉取列表");
            }
            elModelInput.hide();
            elModelSelect.show();
        }
    });

    elPrompt.on("input", function () {
        settings.prompt = $(this).val();
        saveSettingsDebounced();
    });

    $("#xfy_reset_prompt").on("click", function () {
        settings.prompt = DEFAULT_PROMPT;
        elPrompt.val(DEFAULT_PROMPT);
        saveSettingsDebounced();
        notify("info", "已恢复默认 Prompt");
    });
}

jQuery(async () => {
    await initSettingsUI();
    buildFloatingUI();
    buildSelectionPopover();
});
