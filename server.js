const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;

const app = express();
const PORT = 3000;

// 簡單的記憶體快取
const cache = new Map();
const CACHE_TTL = 300000; // 5分鐘

// 從config.js取得本地模型名稱

const { LOCAL_MODEL } = require('./config');



// 快取輔助函數
function getCachedData(key) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.data;
    }
    cache.delete(key);
    return null;
}

function setCachedData(key, data) {
    cache.set(key, {
        data: data,
        timestamp: Date.now()
    });
}

// 啟用CORS和JSON解析
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

// 代理路由處理Anthropic API請求（改用全域 fetch，不再宣告 node-fetch）
app.post('/api/anthropic', async (req, res) => {
    try {
        const { apiKey, requestData } = req.body;
        
        // 輸入驗證
        if (!apiKey || typeof apiKey !== 'string') {
            return res.status(400).json({ error: 'API密鑰是必需的' });
        }
        
        if (!requestData || typeof requestData !== 'object') {
            return res.status(400).json({ error: '請求數據是必需的' });
        }
        
        // 驗證API密鑰格式
        if (!apiKey.startsWith('sk-ant-api03-')) {
            return res.status(400).json({ error: 'API密鑰格式不正確' });
        }

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(requestData)
        });

        const data = await response.json();
        
        if (!response.ok) {
            return res.status(response.status).json(data);
        }
        
        res.json(data);
    } catch (error) {
        console.error('代理服務器錯誤:', error);
        res.status(500).json({ 
            error: '服務器內部錯誤', 
            details: error.message 
        });
    }
});

app.post('/api/ollama', async (req, res) => {
    try {
        const { prompt, imageData } = req.body || {};

        if (!prompt || typeof prompt !== 'string') {
            return res.status(400).json({ error: 'Missing prompt for local analysis' });
        }

        let sanitizedImage = null;
        if (
            imageData &&
            typeof imageData.base64Data === 'string' &&
            imageData.base64Data.trim() !== ''
        ) {
            const trimmed = imageData.base64Data.trim();
            // Remove potential data URI prefix so Ollama receives pure base64
            sanitizedImage = trimmed.replace(/^data:[^,]+,/, '');
        }

// 假設 uploadedImage 是 dataURL；先拿掉前綴
/*
const base64Data = uploadedImage ? uploadedImage.split(',')[1] : undefined;

const systemMsg = [
  'You are a meticulous construction quality inspector.',
  'Always find concrete defects relative to the checklist; never say "no issues".',
  'Keep answers concise and structured; do NOT write "content exceeded" or similar.',
  'Use Traditional Chinese in output.'
].join(' ');

const userMsg = [
  prompt, // 你原本的 analysisPrompt（可包含【可用檢查項目及標準】…）
  '',
  '【輸出規範】',
  '每個章節 ≤ 8 行、每行 ≤ 120 字；必要時以「…其餘略」結尾。',
  '標題必須依序使用：',
  '主要檢查項目／照片內容分析／標準對照檢查／發現的缺失／改善建議／整體評估。'
].join('\n');

const ollamaPayload = {
  model: LOCAL_MODEL,         // 例如 'qwen2.5vl:7b'
  stream: false,
  messages: [
    { role: 'system', content: systemMsg },
    // 有圖就加 images，沒圖這行拿掉即可
    { role: 'user', content: userMsg, images: base64Data ? [base64Data] : undefined },
  ],
  options: {
    num_predict: 3072,  // 依需要可再加大（1024~4096）
    num_ctx: 8192,      // 增加上下文避免早停
    temperature: 0.2
  }
};
*/


        const ollamaPayload = {
            model: LOCAL_MODEL,// 例如 'qwen2.5vl:7b'
            stream: false,
            messages: [
                {
                    role: 'system',
                    content: 'You are a meticulous construction quality inspector who flags every potential defect and explains the reasoning clearly.',
                },
                {
                    role: 'user',
                    content: prompt,
                },
            ],
        };

        if (sanitizedImage) {
            // Ollama expects images in a dedicated array when sending base64 payloads
            ollamaPayload.messages[1].images = [sanitizedImage];
        }

        const response = await fetch('http://127.0.0.1:11434/api/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(ollamaPayload),
        });

        const rawText = await response.text();
        let data = null;

        try {
            data = JSON.parse(rawText);
        } catch (parseError) {
            data = null;
        }

        if (!response.ok) {
            const errorDetail = (data && data.error) || rawText || 'Local model error';
            return res.status(response.status).json({ error: errorDetail });
        }

        const outputText = data && data.message && data.message.content ? data.message.content : (data && data.response) || '';

        res.json({
            provider: 'ollama',
            content: [
                { text: outputText },
            ],
        });
    } catch (error) {
        console.error('Local analysis error:', error);
        res.status(500).json({
            error: 'Local model analysis failed',
            details: error.message,
        });
    }
});


// 獲取檢查類型數據
app.get('/api/inspection-types', async (req, res) => {
    try {
        // 嘗試從快取獲取數據
        const cacheKey = 'inspection_types';
        const cachedData = getCachedData(cacheKey);
        
        if (cachedData) {
            console.log('從快取返回檢查類型數據');
            return res.json(cachedData);
        }
        
        const data = await fsPromises.readFile(path.join(__dirname, 'inspection_types.json'), 'utf8');
        const parsedData = JSON.parse(data);
        
        // 儲存到快取
        setCachedData(cacheKey, parsedData);
        
        res.json(parsedData);
    } catch (error) {
        console.error('讀取檢查類型數據錯誤:', error);
        res.status(500).json({ error: '無法讀取檢查類型數據' });
    }
});

// 保存檢查類型數據
app.post('/api/inspection-types', async (req, res) => {
    try {
        // 輸入驗證
        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({ error: '無效的請求數據' });
        }
        
        // 驗證必要欄位
        const { inspectionTypes, currentType } = req.body;
        if (!inspectionTypes || typeof inspectionTypes !== 'object') {
            return res.status(400).json({ error: '缺少檢查類型數據' });
        }
        
        if (!currentType || typeof currentType !== 'string') {
            return res.status(400).json({ error: '缺少當前類型設定' });
        }
        
        const data = JSON.stringify(req.body, null, 2);
        await fsPromises.writeFile(path.join(__dirname, 'inspection_types.json'), data, 'utf8');
        
        // 更新快取
        setCachedData('inspection_types', req.body);
        
        res.json({ success: true, message: '檢查類型數據已儲存' });
    } catch (error) {
        console.error('儲存檢查類型數據錯誤:', error);
        res.status(500).json({ error: '無法儲存檢查類型數據' });
    }
});

// 刪除檢查類型
app.delete('/api/inspection-types/:typeId', async (req, res) => {
    try {
        const typeId = req.params.typeId;
        
        // 輸入驗證
        if (!typeId || typeof typeId !== 'string' || typeId.trim() === '') {
            return res.status(400).json({ error: '無效的檢查類型ID' });
        }
        
        const data = await fsPromises.readFile(path.join(__dirname, 'inspection_types.json'), 'utf8');
        const inspectionData = JSON.parse(data);
        
        if (!inspectionData.inspectionTypes[typeId]) {
            return res.status(404).json({ error: '檢查類型不存在' });
        }
        
        // 不允許刪除預設的鋼筋檢查類型
        if (typeId === 'rebar') {
            return res.status(400).json({ error: '無法刪除預設的鋼筋檢查類型' });
        }
        
        delete inspectionData.inspectionTypes[typeId];
        
        // 如果刪除的是當前類型，切換到鋼筋檢查
        if (inspectionData.currentType === typeId) {
            inspectionData.currentType = 'rebar';
        }
        
        const newData = JSON.stringify(inspectionData, null, 2);
        await fsPromises.writeFile(path.join(__dirname, 'inspection_types.json'), newData, 'utf8');
        
        // 更新快取
        setCachedData('inspection_types', inspectionData);
        
        res.json({ success: true, message: '檢查類型已刪除' });
    } catch (error) {
        console.error('刪除檢查類型錯誤:', error);
        res.status(500).json({ error: '無法刪除檢查類型' });
    }
});

function extractJsonFromText(text) {
    if (!text || typeof text !== 'string') {
        return null;
    }

    const cleaned = text
        .replace(/```json/gi, '```')
        .replace(/```/g, '')
        .trim();

    try {
        return JSON.parse(cleaned);
    } catch (error) {
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) {
            try {
                return JSON.parse(match[0]);
            } catch (innerErr) {
                return null;
            }
        }
        return null;
    }
}

function extractOllamaText(localData) {
    const textSegments = [];

    const collect = (value) => {
        if (!value) {
            return;
        }
        if (typeof value === 'string') {
            textSegments.push(value);
        } else if (Array.isArray(value)) {
            value.forEach(collect);
        } else if (typeof value === 'object') {
            if (typeof value.text === 'string') {
                textSegments.push(value.text);
            }
            if (Array.isArray(value.content)) {
                collect(value.content);
            }
        }
    };

    collect(localData?.message?.content);
    collect(localData?.response);
    collect(localData?.output_text);
    collect(localData?.output);
    collect(localData?.content);

    return textSegments.join('\n').trim();
}

function sanitizeText(text) {
    if (!text || typeof text !== 'string') return '';
    return text.replace(/\s+/g, ' ').trim();
}

const FALLBACK_ICONS = ['📌', '🛠️', '🔍', '✅', '📏', '🏗️', '🧱', '🔧', '📐', '🧰'];

function normalizeChecklistData(rawChecklist, fallbackName, providerLabel) {
    if (!rawChecklist || typeof rawChecklist !== 'object') {
        return null;
    }

    const nowTag = new Date().toISOString().split('T')[0];
    const fallback = (() => {
        const trimmed = sanitizeText(fallbackName);
        if (!trimmed || trimmed === '自訂檢查項目') {
            const suffix = Math.floor(Date.now() % 100000);
            return `自訂檢查類型 ${nowTag}#${suffix}`;
        }
        return trimmed;
    })();

    const normalizedName = (() => {
        const name = sanitizeText(rawChecklist.name);
        if (!name || name === '自訂檢查項目') {
            return fallback;
        }
        return name;
    })();

    const normalizedDescription = sanitizeText(rawChecklist.description) ||
        `${normalizedName} 的檢查項目 (${providerLabel} 產出於 ${nowTag})`;

    const rawItems = Array.isArray(rawChecklist.items) ? rawChecklist.items : [];
    const normalizedItems = rawItems
        .map((item, idx) => {
            if (!item || typeof item !== 'object') return null;
            const name = sanitizeText(item.name);
            const standard = sanitizeText(item.standard || item.criteria || item.requirement);
            if (!name || !standard) return null;

            const icon = sanitizeText(item.icon);
            const fallbackIcon = FALLBACK_ICONS[idx % FALLBACK_ICONS.length];

            return {
                name,
                icon: icon || fallbackIcon,
                standard
            };
        })
        .filter(Boolean);

    if (normalizedItems.length === 0) {
        return null;
    }

    return {
        name: normalizedName,
        description: normalizedDescription,
        items: normalizedItems
    };
}

// 解析檢查表（改用全域 fetch，不再宣告 node-fetch）
app.post('/api/parse-checklist', async (req, res) => {
    try {
        const { apiKey, imageData, checklistName, provider } = req.body || {};
        const selectedProvider = provider === 'local' ? 'local' : 'cloud';

        if (!imageData || typeof imageData !== 'object' || typeof imageData.base64Data !== 'string' || imageData.base64Data.trim() === '') {
            return res.status(400).json({ error: '檢查表影像數據是必需的' });
        }

        const sanitizedImage = imageData.base64Data.trim().replace(/^data:[^,]+,/, '');
        const mediaType = typeof imageData.mediaType === 'string' && imageData.mediaType.trim() !== ''
            ? imageData.mediaType.trim()
            : 'image/jpeg';

        if (selectedProvider === 'cloud') {
            if (!apiKey || typeof apiKey !== 'string') {
                return res.status(400).json({ error: 'API密鑰是必需的' });
            }

            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-3-7-sonnet-20250219',
                    max_tokens: 4000,
                    messages: [{
                        role: 'user',
                        content: [{
                            type: 'text',
                            text: `請仔細分析這份品質檢查表，提取出所有的檢查項目和對應的檢查標準。

請按照以下JSON格式回應，不要包含任何其他文字：

{
  "name": "${checklistName || '自訂檢查項目'}",
  "description": "從檢查表中提取的檢查項目",
  "items": [
    {
      "name": "檢查項目名稱",
      "icon": "🔧",
      "standard": "具體的檢查標準或要求"
    }
  ]
}

注意事項：
1. 請提取所有能識別的檢查項目
2. 為每個項目選擇合適的emoji圖標
3. 檢查標準要具體明確
4. 只回應JSON格式，不要額外說明`
                        }, {
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: mediaType,
                                data: sanitizedImage
                            }
                        }]
                    }]
                })
            });

            const data = await response.json();

            if (!response.ok) {
                return res.status(response.status).json(data);
            }

            const textContent = Array.isArray(data?.content)
                ? data.content
                    .filter(part => part && typeof part.text === 'string')
                    .map(part => part.text)
                    .join('\n')
                : '';

            const parsedChecklist = extractJsonFromText(textContent);
            if (!parsedChecklist) {
                return res.status(502).json({
                    error: '無法從Claude回應中解析檢查表JSON',
                    raw: textContent || data
                });
            }

            const normalized = normalizeChecklistData(parsedChecklist, checklistName, 'Claude 雲端');

            if (!normalized) {
                return res.status(502).json({
                    error: 'Claude 雲端未產生任何檢查項目，請重新拍攝或改用本地模型',
                    raw: textContent
                });
            }

            return res.json({
                provider: 'cloud',
                checklist: normalized
            });
        }

        // 本地模型解析
        const localRequestBody = {
            model: LOCAL_MODEL,
            stream: false,
            messages: [
                {
                    role: 'system',
                    content: `你是一位專精於土建工程的品質檢查助理，負責從掃描影像或文件中精準抽取檢查表。
嚴格遵守以下規範：
1. 只能輸出符合指定結構的 JSON，禁止任何額外文字、註解或 markdown。
2. "name" 欄位必須填入文件最上方的正式標題文字（例如「瀝青混凝土鋪築工程自主檢查表」），若文件沒有標題才可使用使用者提供的名稱。
3. "items" 陣列必須完整列出表格中所有檢查項目，不得省略；若影像品質差無法讀取，也要根據資料合理推測列出至少 8 項。
4. 每個項目需包含：emoji 圖示（單一 emoji）、簡潔的項目名稱，以及以繁體中文描述的具體檢查標準。
5. 若文件包含多列表格，須逐列解析並組合為完整的檢查項目列表。`
                },
                {
                    role: 'user',
                    content: `請仔細分析這份品質檢查表，提取出所有的檢查項目和對應的檢查標準。

請按照以下JSON格式回應，不要包含任何其他文字：

{
  "name": "${checklistName || '自訂檢查項目'}",
  "description": "從檢查表中提取的檢查項目",
  "items": [
    {
      "name": "檢查項目名稱",
      "icon": "🔧",
      "standard": "具體的檢查標準或要求"
    }
  ]
}

注意事項：
1. 請提取所有能識別的檢查項目
2. 為每個項目選擇合適的emoji圖標
3. 檢查標準要具體明確，使用繁體中文描述
4. 只回應JSON格式，不要額外說明
5. 若影像資訊有限，仍需根據此類工程常見規範列出所有應檢項目，至少 8 項`
                }
            ]
        };

        if (sanitizedImage) {
            localRequestBody.messages[1].images = [sanitizedImage];
        }

        const localResponse = await fetch('http://127.0.0.1:11434/api/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(localRequestBody)
        });

        const rawLocal = await localResponse.text();
        let localData = null;

        try {
            localData = JSON.parse(rawLocal);
        } catch (parseError) {
            return res.status(502).json({ error: '本地模型回傳格式無法解析', details: parseError.message, raw: rawLocal });
        }

        if (!localResponse.ok) {
            const errorDetail = (localData && localData.error) || rawLocal || 'Local model error';
            return res.status(localResponse.status).json({ error: errorDetail });
        }

        const localText = extractOllamaText(localData);

        if (!localText) {
            return res.status(502).json({ error: '無法取得本地模型輸出內容' });
        }

        const parsedChecklist = extractJsonFromText(localText);

        if (!parsedChecklist) {
            return res.status(502).json({
                error: '無法從本地模型輸出解析檢查表JSON',
                raw: localText
            });
        }

        const normalized = normalizeChecklistData(parsedChecklist, checklistName, 'Ollama ');

        if (!normalized) {
            return res.status(502).json({
                error: '本地模型未產生任何檢查項目，請重新拍攝或改用雲端模式',
                raw: localText
            });
        }

        if (!Array.isArray(normalized.items) || normalized.items.length < 8) {
            return res.status(502).json({
                error: '本地模型產生的檢查項目數量不足（少於 8 項），請重新上傳或改用雲端模式',
                raw: normalized
            });
        }

        return res.json({
            provider: 'local',
            checklist: normalized
        });
    } catch (error) {
        console.error('解析檢查表錯誤:', error);
        res.status(500).json({ 
            error: '解析檢查表失敗', 
            details: error.message 
        });
    }
});

// 提供靜態文件
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'rebar_inspection_tool.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 代理服務器運行在 http://localhost:${PORT}`);
    console.log(`📝 打開瀏覽器訪問 http://localhost:${PORT} 來使用鋼筋檢查工具`);
});
