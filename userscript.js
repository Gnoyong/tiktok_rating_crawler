// ==UserScript==
// @name         TikTok Seller API Helper
// @namespace    https://github.com/
// @version      0.1.0
// @description  TikTok Seller API helper for user info, order export and download URL
// @author       you
// @match        https://seller-us.tiktok.com/*
// @match        https://seller.tiktokshopglobalselling.com/*
// @match        https://seller.us.tiktokshopglobalselling.com/*
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const pageFetch = pageWindow.fetch.bind(pageWindow);
    const REVIEW_PANEL_ID = 'seller-api-review-panel';
    const REVIEW_PANEL_STYLE_ID = 'seller-api-review-panel-style';
    const REVIEW_TIMEZONE = 'America/Los_Angeles';

    function getCookie(name) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const m = document.cookie.match(new RegExp('(?:^|; )' + escaped + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : '';
    }

    function withTimeout(promise, ms, label) {
        const timeoutMs = Number(ms) > 0 ? Number(ms) : 30000;
        let timer = null;
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(label + '_TIMEOUT')), timeoutMs);
        });
        return Promise.race([promise, timeoutPromise]).finally(() => {
            if (timer) clearTimeout(timer);
        });
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function toUnixSeconds(value) {
        if (value === undefined || value === null || value === '') {
            throw new Error('INVALID_TIME: ' + value);
        }
        if (typeof value === 'number') {
            return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
        }
        const text = String(value).trim();
        if (/^\d+$/.test(text)) {
            const numeric = Number(text);
            return numeric > 1e12 ? Math.floor(numeric / 1000) : Math.floor(numeric);
        }
        return zonedDateTimeToUnixSeconds(text, REVIEW_TIMEZONE);
    }

    function getOffsetMinutesByTimeZone(timeZone, epochMs) {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone,
            timeZoneName: 'shortOffset',
            hour: '2-digit',
        }).formatToParts(new Date(epochMs));
        const name = (parts.find((p) => p.type === 'timeZoneName') || {}).value || 'GMT+0';
        const match = name.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
        if (!match) {
            return 0;
        }
        const sign = match[1] === '-' ? -1 : 1;
        const hh = Number(match[2] || '0');
        const mm = Number(match[3] || '0');
        return sign * (hh * 60 + mm);
    }

    function zonedDateTimeToUnixSeconds(value, timeZone) {
        const m = String(value)
            .trim()
            .match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?$/);
        if (!m) {
            const fallback = new Date(String(value)).getTime();
            if (!Number.isFinite(fallback)) {
                throw new Error('INVALID_TIME: ' + value);
            }
            return Math.floor(fallback / 1000);
        }
        const year = Number(m[1]);
        const month = Number(m[2]);
        const day = Number(m[3]);
        const hour = Number(m[4]);
        const minute = Number(m[5]);
        const second = Number(m[6] || '0');

        const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
        let offset = getOffsetMinutesByTimeZone(timeZone, utcGuess);
        let epochMs = utcGuess - offset * 60000;
        const correctedOffset = getOffsetMinutesByTimeZone(timeZone, epochMs);
        if (correctedOffset !== offset) {
            epochMs = utcGuess - correctedOffset * 60000;
        }
        return Math.floor(epochMs / 1000);
    }

    function formatReviewTime(value) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0) {
            return '';
        }
        const millis = numeric < 1e12 ? numeric * 1000 : numeric;
        return new Date(millis).toLocaleString();
    }

    function escapeCsvCell(value) {
        const text = value === undefined || value === null ? '' : String(value);
        return '"' + text.replace(/"/g, '""') + '"';
    }

    function downloadTextFile(filename, content, mimeType) {
        const blob = new Blob([content], { type: mimeType || 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function parseCsvNumbers(text, fallback) {
        if (text === undefined || text === null || String(text).trim() === '') {
            return fallback || [];
        }
        return String(text)
            .split(',')
            .map((item) => Number(String(item).trim()))
            .filter((item) => Number.isFinite(item));
    }

    function normalizeStarLevels(value, fallback) {
        if (Array.isArray(value)) {
            const arr = value
                .map((item) => Number(item))
                .filter((item) => Number.isFinite(item) && item >= 1 && item <= 5);
            return arr.length ? arr : fallback || [];
        }
        return parseCsvNumbers(value, fallback);
    }

    function parseJsonObject(text, label) {
        const trimmed = String(text || '').trim();
        if (!trimmed) {
            return {};
        }
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        } catch (err) {
            throw new Error(label + ' JSON 解析失败: ' + err.message);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(label + ' 必须是 JSON 对象');
        }
        return parsed;
    }

    function toReviewRows(response) {
        const list = response?.data?.list;
        if (!Array.isArray(list)) {
            return [];
        }
        return list.map((item) => ({
            order_id: item?.order_id || '',
            product_id: item?.product_info?.product_id || '',
            review_time: formatReviewTime(item?.review_time),
            reviews: item?.review_text || '',
            rating: item?.star_level ?? '',
        }));
    }

    function reviewRowsToCsv(rows) {
        const header = ['order_id', 'product_id', 'review_time', 'reviews', 'rating'];
        const lines = [header.map(escapeCsvCell).join(',')];
        rows.forEach((row) => {
            lines.push(
                [row.order_id, row.product_id, row.review_time, row.reviews, row.rating]
                    .map(escapeCsvCell)
                    .join(',')
            );
        });
        return lines.join('\n');
    }

    function defaultDateTimeLocal(offsetMs) {
        const date = new Date(Date.now() + offsetMs);
        const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
        return local.toISOString().slice(0, 16);
    }

    function getDatePartsInTimeZone(date, timeZone) {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).formatToParts(date);
        const year = (parts.find((p) => p.type === 'year') || {}).value;
        const month = (parts.find((p) => p.type === 'month') || {}).value;
        const day = (parts.find((p) => p.type === 'day') || {}).value;
        return { year, month, day };
    }

    function defaultDateTimeBoundary(offsetDays, isEnd) {
        const shifted = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
        const parts = getDatePartsInTimeZone(shifted, REVIEW_TIMEZONE);
        const yyyy = String(parts.year);
        const mm = String(parts.month).padStart(2, '0');
        const dd = String(parts.day).padStart(2, '0');
        return yyyy + '-' + mm + '-' + dd + 'T' + (isEnd ? '23:59:59' : '00:00:00');
    }

    function normalizeDateBoundary(value, isEnd) {
        const text = String(value || '').trim();
        const datePart = /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : '';
        if (!datePart) {
            throw new Error('INVALID_DATE: ' + value);
        }
        return datePart + 'T' + (isEnd ? '23:59:59' : '00:00:00');
    }

    function detectEnv() {
        const host = location.hostname;
        const isUs = host === 'seller-us.tiktok.com';
        return {
            baseUrl: location.origin,
            timezoneName: isUs ? 'America/Los_Angeles' : 'Asia/Hong_Kong',
            appName: isUs ? 'i18n_ecom_shop' : 'i18n_ecom_alliance',
            language: 'en',
            locale: 'en',
            aid: getCookie('app_id_unified_seller_env') || (isUs ? '4068' : '6556'),
            oecSellerId: getCookie('oec_seller_id_unified_seller_env') || '',
            shopRegion: 'US',
        };
    }

    function buildCommonParams(env, overrides) {
        const fp = getCookie('s_v_web_id') || '';
        return Object.assign(
            {
                locale: env.locale,
                language: env.language,
                aid: env.aid,
                app_name: env.appName,
                oec_seller_id: env.oecSellerId,
                fp,
                device_platform: 'web',
                cookie_enabled: 'true',
                screen_width: String(window.screen.width || 1920),
                screen_height: String(window.screen.height || 1080),
                browser_language: navigator.language || 'en-US',
                browser_platform: navigator.platform || 'Win32',
                browser_name: 'Mozilla',
                browser_version: navigator.userAgent,
                browser_online: String(navigator.onLine),
                timezone_name: env.timezoneName,
                shop_region: env.shopRegion,
            },
            overrides || {}
        );
    }

    function createSellerApi() {
        const env = detectEnv();

        function buildUrl(path, params) {
            const fullPath = path.startsWith('/') ? path : '/' + path;
            const url = new URL(env.baseUrl + fullPath);
            if (params && typeof params === 'object') {
                Object.entries(params).forEach(([k, v]) => {
                    if (v !== undefined && v !== null && v !== '') {
                        url.searchParams.set(k, String(v));
                    }
                });
            }
            return url.toString();
        }

        async function request(path, options) {
            const method = (options && options.method) || 'GET';
            const body = options && options.body;
            const timeoutMs = (options && options.timeoutMs) || 30000;
            const onlyAdditional = Boolean(options && options.onlyAdditional);
            const additionalParams = (options && options.additionalParams) || {};

            const params = onlyAdditional
                ? additionalParams
                : buildCommonParams(env, additionalParams);

            const url = buildUrl(path, params);
            const headers = new Headers((options && options.headers) || { 'content-type': 'application/json' });

            const fetchOptions = {
                method,
                credentials: 'include',
                headers,
            };

            if (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD') {
                fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
            }

            const response = await withTimeout(pageFetch(url, fetchOptions), timeoutMs, 'FETCH');
            const text = await response.text();
            let data;

            try {
                data = text ? JSON.parse(text) : {};
            } catch (err) {
                throw new Error('NON_JSON_RESPONSE status=' + response.status + ' body=' + text.slice(0, 300));
            }

            if (!response.ok) {
                throw new Error('HTTP_' + response.status + ' ' + JSON.stringify(data));
            }

            if (typeof data === 'object' && data !== null && 'code' in data && data.code !== 0) {
                throw new Error('BIZ_' + data.code + ' ' + (data.message || '') + ' ' + JSON.stringify(data));
            }

            return data;
        }

        function toMillis(value) {
            if (value instanceof Date) return value.getTime();
            if (typeof value === 'number') return value;
            const t = new Date(String(value)).getTime();
            if (!Number.isFinite(t)) {
                throw new Error('INVALID_TIME: ' + value);
            }
            return t;
        }

        return {
            env,

            async userInfo() {
                return request('/passport/account/info/v2/', {
                    method: 'GET',
                    onlyAdditional: true,
                    additionalParams: {
                        aid: env.aid,
                        language: env.language,
                        get_info_type: '2',
                    },
                });
            },

            async getBuyerInfo(orderIds) {
                if (!Array.isArray(orderIds) || orderIds.length === 0) {
                    throw new Error('orderIds is required');
                }
                return request('/api/v1/fulfillment/na/orders/buyer', {
                    method: 'POST',
                    body: { main_order_ids: orderIds },
                });
            },

            async getReviewList(options) {
                const reviewStartTime = toUnixSeconds(options && options.reviewStartTime);
                const reviewEndTime = toUnixSeconds(options && options.reviewEndTime);
                const page = Number((options && options.page) || 1);
                const size = Number((options && options.size) || 10);
                const starLevels = normalizeStarLevels(options && options.starLevels, [1, 2, 3, 4, 5]);
                const fuzzyParam = String((options && options.fuzzyParam) || '').trim();
                const extraQueryParams = Object.assign(
                    {
                        msToken: getCookie('msToken') || '',
                    },
                    (options && options.extraQueryParams) || {}
                );
                const extraBody = (options && options.extraBody) || {};

                const requestOptions = {
                    method: 'POST',
                    additionalParams: extraQueryParams,
                    body: Object.assign(
                        {
                            star_level: starLevels.length ? starLevels : [1, 2, 3, 4, 5],
                            review_start_time: reviewStartTime,
                            review_end_time: reviewEndTime,
                            page,
                            size,
                        },
                        extraBody
                    ),
                }

                if (fuzzyParam) {
                    requestOptions.body.fuzzy_param = fuzzyParam;
                }

                return request('/api/v1/review/biz_backend/list', requestOptions);
            },

            async getAllReviewRows(options) {
                const size = Number((options && options.size) || 50);
                const allRows = [];
                let page = Number((options && options.page) || 1);
                let total = Infinity;

                while (allRows.length < total) {
                    const response = await this.getReviewList(Object.assign({}, options, { page, size }));
                    const rows = toReviewRows(response);
                    const responseTotal = Number(response?.data?.total);

                    if (Number.isFinite(responseTotal) && responseTotal >= 0) {
                        total = responseTotal;
                    }

                    if (!rows.length) {
                        break;
                    }

                    allRows.push(...rows);

                    if (rows.length < size) {
                        break;
                    }

                    page += 1;
                    await sleep(250);
                }

                return allRows;
            },

            async exportOrders(startTime, endTime, options) {
                const startMs = toMillis(startTime);
                const endMs = toMillis(endTime);
                const sortInfo = (options && options.sortInfo) || '6';
                const fileType = (options && options.fileType) || 2;

                const defaultName =
                    'all_order-' +
                    new Date(startMs).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) +
                    '_' +
                    new Date(endMs).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) +
                    '.csv';
                const fileName = encodeURIComponent((options && options.fileName) || defaultName);

                return request('/api/fulfillment/na/order/export', {
                    method: 'POST',
                    body: {
                        search_condition: {
                            condition_list: {
                                time_order_created: {
                                    value: [String(startMs), String(endMs)],
                                },
                            },
                        },
                        sort_info: String(sortInfo),
                        file_name: fileName,
                        file_type: Number(fileType),
                    },
                });
            },

            async getExportRecords() {
                return request('/api/fulfillment/na/order/export_record/get', {
                    method: 'POST',
                    body: {},
                });
            },

            async postDownload(fileKey, exportTaskId) {
                if (!fileKey || !exportTaskId) {
                    throw new Error('fileKey and exportTaskId are required');
                }
                return request('/api/fulfillment/na/order/download', {
                    method: 'POST',
                    body: {
                        file_key: String(fileKey),
                        export_task_id: String(exportTaskId),
                    },
                });
            },

            async waitExportAndGetDownloadUrl(exportTaskId, maxWaitMs, pollMs) {
                const timeoutMs = Number(maxWaitMs) > 0 ? Number(maxWaitMs) : 180000;
                const intervalMs = Number(pollMs) > 0 ? Number(pollMs) : 3000;
                const start = Date.now();

                while (Date.now() - start < timeoutMs) {
                    const recordsRes = await this.getExportRecords();
                    const records =
                        recordsRes && recordsRes.data && Array.isArray(recordsRes.data.export_records)
                            ? recordsRes.data.export_records
                            : [];

                    const row = records.find((x) => String(x.export_task_id) === String(exportTaskId));
                    if (row && row.file_key && Number(row.download) === 1) {
                        return this.postDownload(row.file_key, row.export_task_id);
                    }

                    await sleep(intervalMs);
                }

                throw new Error('EXPORT_WAIT_TIMEOUT task=' + exportTaskId);
            },
        };
    }

    function createReviewPanel(api) {
        function ensureStyle() {
            if (document.getElementById(REVIEW_PANEL_STYLE_ID)) {
                return;
            }
            const style = document.createElement('style');
            style.id = REVIEW_PANEL_STYLE_ID;
            style.textContent = [
                '#' + REVIEW_PANEL_ID + ' {',
                'position: fixed;',
                'top: 16px;',
                'right: 16px;',
                'width: min(980px, calc(100vw - 32px));',
                'max-height: calc(100vh - 32px);',
                'z-index: 2147483647;',
                'background: #ffffff;',
                'border: 1px solid #e5e7eb;',
                'border-radius: 12px;',
                'box-shadow: 0 12px 32px rgba(0, 0, 0, 0.16);',
                'font: 13px/1.5 "TikTokText", "Segoe UI", "PingFang SC", sans-serif;',
                'color: #161823;',
                'overflow: hidden;',
                '}',
                '#' + REVIEW_PANEL_ID + ' * { box-sizing: border-box; }',
                '#' + REVIEW_PANEL_ID + ' .seller-api-head {',
                'display: flex;',
                'justify-content: space-between;',
                'align-items: center;',
                'padding: 14px 18px;',
                'background: #ffffff;',
                'border-bottom: 1px solid #eef0f2;',
                'color: #161823;',
                '}',
                '#' + REVIEW_PANEL_ID + ' .seller-api-title { font-size: 16px; font-weight: 700; }',
                '#' + REVIEW_PANEL_ID + ' .seller-api-subtitle { font-size: 12px; color: #6b7280; margin-top: 2px; }',
                '#' + REVIEW_PANEL_ID + ' .seller-api-close {',
                'border: 1px solid #e5e7eb;',
                'background: #ffffff;',
                'color: #4b5563;',
                'width: 32px;',
                'height: 32px;',
                'border-radius: 8px;',
                'cursor: pointer;',
                'font-size: 18px;',
                '}',
                '#' + REVIEW_PANEL_ID + ' .seller-api-body { padding: 16px 18px 18px; overflow: auto; max-height: calc(100vh - 88px); background: #fafafa; }',
                '#' + REVIEW_PANEL_ID + ' .seller-api-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }',
                '#' + REVIEW_PANEL_ID + ' .seller-api-field { display: flex; flex-direction: column; gap: 6px; }',
                '#' + REVIEW_PANEL_ID + ' .seller-api-field-wide { grid-column: 1 / -1; }',
                '#' + REVIEW_PANEL_ID + ' label { font-weight: 600; color: #374151; }',
                '#' + REVIEW_PANEL_ID + ' input, #' + REVIEW_PANEL_ID + ' textarea {',
                'width: 100%;',
                'border: 1px solid #d1d5db;',
                'border-radius: 8px;',
                'padding: 10px 12px;',
                'background: #ffffff;',
                'color: #111827;',
                '}',
                '#' + REVIEW_PANEL_ID + ' input[name="reviewStartTime"], #' + REVIEW_PANEL_ID + ' input[name="reviewEndTime"] { font-variant-numeric: tabular-nums; }',
                '#' + REVIEW_PANEL_ID + ' input[name="reviewStartTime"]::-webkit-datetime-edit-ampm-field, #' + REVIEW_PANEL_ID + ' input[name="reviewEndTime"]::-webkit-datetime-edit-ampm-field { display: none; }',
                '#' + REVIEW_PANEL_ID + ' textarea { min-height: 88px; resize: vertical; font-family: Consolas, "Courier New", monospace; }',
                '#' + REVIEW_PANEL_ID + ' .seller-api-stars { display: flex; gap: 10px; flex-wrap: wrap; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; background: #fff; }',
                '#' + REVIEW_PANEL_ID + ' .seller-api-star-item { display: inline-flex; align-items: center; gap: 4px; color: #111827; font-weight: 500; }',
                '#' + REVIEW_PANEL_ID + ' .seller-api-star-item input { width: 14px; height: 14px; }',
                '#' + REVIEW_PANEL_ID + ' .seller-api-actions { display: flex; gap: 10px; flex-wrap: wrap; margin: 16px 0 12px; }',
                '#' + REVIEW_PANEL_ID + ' button[data-role="action"] {',
                'border: 1px solid transparent;',
                'border-radius: 8px;',
                'padding: 10px 16px;',
                'cursor: pointer;',
                'font-weight: 600;',
                '}',
                '#' + REVIEW_PANEL_ID + ' .seller-api-primary { background: #fe2c55; color: #fff; }',
                '#' + REVIEW_PANEL_ID + ' .seller-api-secondary { background: #fff; color: #111827; border-color: #d1d5db; }',
                '#' + REVIEW_PANEL_ID + ' .seller-api-status {',
                'min-height: 38px;',
                'padding: 10px 12px;',
                'border-radius: 8px;',
                'background: #fff;',
                'border: 1px solid #e5e7eb;',
                'color: #374151;',
                'margin-bottom: 12px;',
                'white-space: pre-wrap;',
                '}',
                '#' + REVIEW_PANEL_ID + ' .seller-api-summary { margin-bottom: 12px; color: #4b5563; }',
                '#' + REVIEW_PANEL_ID + ' table { width: 100%; border-collapse: collapse; }',
                '#' + REVIEW_PANEL_ID + ' th, #' + REVIEW_PANEL_ID + ' td { padding: 8px 10px; border-bottom: 1px solid #eef0f2; text-align: left; vertical-align: top; }',
                '#' + REVIEW_PANEL_ID + ' th { position: sticky; top: 0; background: #f8fafc; font-size: 12px; text-transform: uppercase; letter-spacing: 0.02em; color: #6b7280; }',
                '#' + REVIEW_PANEL_ID + ' .seller-api-table-wrap { border: 1px solid #e5e7eb; border-radius: 8px; overflow: auto; max-height: 360px; background: #fff; }',
                '@media (max-width: 720px) {',
                '#' + REVIEW_PANEL_ID + ' { top: 8px; right: 8px; left: 8px; width: auto; max-height: calc(100vh - 16px); }',
                '#' + REVIEW_PANEL_ID + ' .seller-api-grid { grid-template-columns: 1fr; }',
                '}',
            ].join('');
            document.head.appendChild(style);
        }

        function getExistingPanel() {
            return document.getElementById(REVIEW_PANEL_ID);
        }

        function setStatus(panel, message) {
            panel.querySelector('[data-role="status"]').textContent = message;
        }

        function renderRows(panel, rows) {
            const body = panel.querySelector('[data-role="tbody"]');
            if (!rows.length) {
                body.innerHTML = '<tr><td colspan="5">暂无数据</td></tr>';
                return;
            }
            body.innerHTML = '';
            const fragment = document.createDocumentFragment();
            rows.forEach((row) => {
                const tr = document.createElement('tr');
                [row.order_id, row.product_id, row.review_time, row.reviews, row.rating].forEach(
                    (value) => {
                        const td = document.createElement('td');
                        td.textContent = value === undefined || value === null ? '' : String(value);
                        tr.appendChild(td);
                    }
                );
                fragment.appendChild(tr);
            });
            body.appendChild(fragment);
        }

        function buildRequestOptions(panel) {
            const starLevels = Array.from(
                panel.querySelectorAll('input[name="starLevels"]:checked')
            ).map((el) => Number(el.value));
            const normalizedStart = normalizeDateBoundary(
                panel.querySelector('[name="reviewStartTime"]').value,
                false
            );
            const normalizedEnd = normalizeDateBoundary(
                panel.querySelector('[name="reviewEndTime"]').value,
                true
            );
            return {
                reviewStartTime: normalizedStart,
                reviewEndTime: normalizedEnd,
                size: 50,
                fuzzyParam: panel.querySelector('[name="fuzzyParam"]').value,
                starLevels,
                extraQueryParams: {},
                extraBody: {},
            };
        }

        function updateBusy(panel, busy) {
            panel.querySelectorAll('button[data-role="action"]').forEach((button) => {
                button.disabled = busy;
                button.style.opacity = busy ? '0.65' : '1';
            });
        }

        async function handleFetchAll(panel) {
            updateBusy(panel, true);
            setStatus(panel, '正在分页拉取全部数据...');
            try {
                const options = buildRequestOptions(panel);
                const rows = await api.getAllReviewRows(options);
                panel.__reviewRows = rows;
                renderRows(panel, rows.slice(0, Math.min(rows.length, 200)));
                panel.querySelector('[data-role="summary"]').textContent =
                    '共抓取 ' + rows.length + ' 条' + (rows.length > 200 ? '，表格仅预览前 200 条' : '');
                setStatus(panel, '查询成功，共 ' + rows.length + ' 条');
                console.log('[sellerApi.reviewList all]', rows);
            } catch (err) {
                setStatus(panel, '查询失败: ' + (err && err.message ? err.message : String(err)));
                throw err;
            } finally {
                updateBusy(panel, false);
            }
        }

        async function handleExportCsv(panel) {
            const rows = Array.isArray(panel.__reviewRows) ? panel.__reviewRows : [];
            if (!rows.length) {
                setStatus(panel, '没有可导出的数据，请先查询');
                return;
            }
            const csv = reviewRowsToCsv(rows);
            const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
            downloadTextFile('review_list_' + stamp + '.csv', csv, 'text/csv;charset=utf-8');
            setStatus(panel, '已导出 ' + rows.length + ' 条');
        }

        function wireEvents(panel) {
            panel.querySelector('[data-role="close"]').addEventListener('click', () => panel.remove());
            panel.querySelector('[data-action="fetch-all"]').addEventListener('click', () => {
                handleFetchAll(panel).catch((err) => console.error('[sellerApi.reviewList.all] error', err));
            });
            panel.querySelector('[data-action="export-csv"]').addEventListener('click', () => {
                handleExportCsv(panel).catch((err) => console.error('[sellerApi.reviewExport] error', err));
            });
        }

        function createPanelElement() {
            const panel = document.createElement('div');
            panel.id = REVIEW_PANEL_ID;
            panel.innerHTML = [
                '<div class="seller-api-head">',
                '<div>',
                '<div class="seller-api-title">TikTok 评论导出</div>',
                '<div class="seller-api-subtitle">填写评论查询参数，导出 order_id、product_id、review_time、reviews、rating</div>',
                '</div>',
                '<button class="seller-api-close" data-role="close" type="button">×</button>',
                '</div>',
                '<div class="seller-api-body">',
                '<div class="seller-api-grid">',
                '<div class="seller-api-field"><label>开始日期</label><input name="reviewStartTime" type="datetime-local" lang="en-GB" step="1" value="' + defaultDateTimeBoundary(-7, false) + '"></div>',
                '<div class="seller-api-field"><label>截止日期</label><input name="reviewEndTime" type="datetime-local" lang="en-GB" step="1" value="' + defaultDateTimeBoundary(0, true) + '"></div>',
                '<div class="seller-api-field seller-api-field-wide"><label>搜索 Order Id、Product Name、ID、Username</label><input name="fuzzyParam" type="text" placeholder="输入关键词"></div>',
                '<div class="seller-api-field seller-api-field-wide"><label>星级筛选</label><div class="seller-api-stars">'
                + '<label class="seller-api-star-item"><input type="checkbox" name="starLevels" value="1" checked><span>1⭐</span></label>'
                + '<label class="seller-api-star-item"><input type="checkbox" name="starLevels" value="2" checked><span>2⭐</span></label>'
                + '<label class="seller-api-star-item"><input type="checkbox" name="starLevels" value="3" checked><span>3⭐</span></label>'
                + '<label class="seller-api-star-item"><input type="checkbox" name="starLevels" value="4" checked><span>4⭐</span></label>'
                + '<label class="seller-api-star-item"><input type="checkbox" name="starLevels" value="5" checked><span>5⭐</span></label>'
                + '</div></div>',
                '</div>',
                '<div class="seller-api-actions">',
                '<button class="seller-api-primary" data-role="action" data-action="fetch-all" type="button">查询全部</button>',
                '<button class="seller-api-secondary" data-role="action" data-action="export-csv" type="button">导出 CSV</button>',
                '</div>',
                '<div class="seller-api-status" data-role="status">准备就绪</div>',
                '<div class="seller-api-summary" data-role="summary">尚未查询</div>',
                '<div class="seller-api-table-wrap">',
                '<table>',
                '<thead><tr><th>order_id</th><th>product_id</th><th>review_time</th><th>reviews</th><th>rating</th></tr></thead>',
                '<tbody data-role="tbody"><tr><td colspan="5">暂无数据</td></tr></tbody>',
                '</table>',
                '</div>',
                '</div>',
            ].join('');
            return panel;
        }

        return {
            open() {
                ensureStyle();
                const existing = getExistingPanel();
                if (existing) {
                    existing.style.display = 'block';
                    return existing;
                }
                const panel = createPanelElement();
                wireEvents(panel);
                document.body.appendChild(panel);
                return panel;
            },
        };
    }

    const sellerApi = createSellerApi();
    const sellerApiReviewGui = createReviewPanel(sellerApi);
    pageWindow.sellerApi = sellerApi;
    pageWindow.sellerApiReviewGui = sellerApiReviewGui;

    GM_registerMenuCommand('评论导出面板', () => {
        sellerApiReviewGui.open();
    });

    console.log('[sellerApi] ready', sellerApi.env);
})();
