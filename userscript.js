// ==UserScript==
// @name         评价数据导出
// @namespace    http://tampermonkey.net/
// @version      2025-12-26
// @description  try to take over the world!
// @author       You
// @match        https://seller-us.tiktok.com/*
// @match        https://seller.us.tiktokshopglobalselling.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=tiktok.com
// @grant        GM.setValue
// @grant        GM.getValue
// @require https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js
// @require https://cdn.jsdelivr.net/npm/dayjs@1.11.19/dayjs.min.js
// @updateURL https://raw.githubusercontent.com/Gnoyong/tiktok_rating_crawler/refs/heads/main/userscript.js
// @downloadURL https://raw.githubusercontent.com/Gnoyong/tiktok_rating_crawler/refs/heads/main/userscript.js
// ==/UserScript==


(async function () {
    'use strict';
    // =======================
    // ====== JSDoc 类型提示 ======
    // =======================
    /**
     * @typedef {Object} RatingRecord
     * @property {string} orderId
     * @property {string} orderTime
     * @property {string} productId
     * @property {string} productName
     * @property {string} skuId
     * @property {string} skuName
     * @property {number} rating
     * @property {string} reviewTime
     * @property {string} reviewText
     */
    let isWorking = false
    /** @type {RatingRecord[]} */
    let tableData = [];

    let isStep1Done = false

    let overlayEl = null;

    async function initWorkingState() {
        isWorking = await GM.getValue("isWorking", false);
        await setWorking(isWorking); // 刷新界面状态
        updateDataCount();
    }


    async function initTableData() {
        tableData = await GM.getValue("tableData", []);
        console.log("恢复持久化 tableData:", tableData);
    }

    async function setTableData(data) {
        tableData = data;
        await GM.setValue("tableData", data);
        updateDataCount();
    }

    async function reset() {
        console.log("🔄 正在重置状态...");
        hideRunningOverlay()
        // 清空全局变量
        isWorking = false;
        tableData = [];
        await setWorking(false)
        // 清空持久化数据
        // await GM.setValue("isWorking", false);
        await GM.setValue("tableData", []);

        // 恢复按钮 UI 状态
        const btn = document.querySelector("#btn-export-xlsx");
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = "导出 Excel";
        }

        updateDataCount();
        console.log("✅ 已重置所有状态");
    }


    // =======================
    // ====== CRUD 函数 ======
    // =======================
    /**
     * 添加一条记录
     * @param {RatingRecord} record
     */
    function addRecord(record) {
        tableData.push(record);
    }

    /**
     * 获取全部记录
     * @returns {RatingRecord[]}
     */
    function getRecords() {
        return [...tableData];
    }

    /**
     * 根据订单ID查询
     * @param {string} orderId
     * @returns {RatingRecord|undefined}
     */
    function getRecordByOrderId(orderId) {
        return tableData.find(r => r.orderId === orderId);
    }

    /**
     * 根据订单ID更新记录
     * @param {string} orderId
     * @param {Partial<RatingRecord>} newData
     * @returns {boolean} 是否更新成功
     */
    function updateRecord(orderId, newData) {
        const index = tableData.findIndex(r => r.orderId === orderId);
        if (index !== -1) {
            tableData[index] = { ...tableData[index], ...newData };
            return true;
        }
        return false;
    }

    /**
     * 删除记录
     * @param {string} orderId
     * @returns {boolean} 是否删除成功
     */
    function deleteRecord(orderId) {
        const index = tableData.findIndex(r => r.orderId === orderId);
        if (index !== -1) {
            tableData.splice(index, 1);
            return true;
        }
        return false;
    }

    /**
     * 清空所有数据
     */
    function clearAll() {
        tableData.length = 0;
    }

    /**
     * 等待指定元素出现
     * @param {string} selector - CSS选择器
     * @param {number} timeout - 超时时间，单位 ms
     * @param {number} interval - 轮询间隔，单位 ms
     * @returns {Promise<Element>} - 找到的元素
     */
    function waitForElement(selector, timeout = 5000, interval = 100) {
        return new Promise((resolve, reject) => {
            const timer = setInterval(() => {
                const el = document.querySelector(selector);
                if (el) {
                    clearInterval(timer);
                    resolve(el);
                }
            }, interval);
            setTimeout(() => {
                clearInterval(timer);
                reject(new Error("元素超时未出现: " + selector));
            }, timeout);
        });
    }

    function waitForChildElement(parent, selector, timeout = 10000, interval = 100) {
        return new Promise((resolve, reject) => {
            const timer = setInterval(() => {
                const el = parent.querySelector(selector);
                if (el) {
                    clearInterval(timer);
                    resolve(el);
                }
            }, interval);

            setTimeout(() => {
                clearInterval(timer);
                reject(new Error("子元素超时未出现: " + selector));
            }, timeout);
        });
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }


    /**
     * 获取 Review Details 弹窗内容
     * @returns {Promise<Array<{author: string, time: string, content: string}>>}
     */
    async function getReviewDetails() {
        // 等待弹窗出现
        const drawer = await waitForElement('.core-drawer');

        // 校验是否是 Review Details 弹窗
        const hasReviewTitle = Array.from(
            drawer.querySelectorAll('h1, h2, h3, div, span')
        ).some(el => {
            const text = el.textContent?.trim();
            return text === 'Review Details' || text === '评价详情';
        });

        if (!hasReviewTitle) {
            console.warn('当前弹窗不是 Review Details');
            return [];
        }

        // 等待评论节点出现（代替 setTimeout）
        await waitForChildElement(drawer, '.mt-8');

        const reviewContainers = Array.from(
            drawer.querySelectorAll('.mt-8')
        ).filter(el => el.classList.length === 1);

        const reviews = reviewContainers.map(container => {
            const author =
                container
                    .querySelector('.text-p3-regular.text-neutral-text3')
                    ?.textContent
                    ?.trim() || '';

            const time =
                container
                    .querySelector('p.text-body-m-regular span')
                    ?.textContent
                    ?.trim() || '';

            const content =
                container
                    .querySelector(
                        '.text-p3-regular.text-neutral-text1.mt-4.whitespace-pre-line'
                    )
                    ?.textContent
                    ?.trim() || '';

            return { author, time, content };
        });

        // 关闭弹窗
        if (!(await closeDrawerWithRetry(drawer))) {
            await destroyDrawer(drawer);
        }

        return reviews;
    }


    async function destroyDrawer(drawer) {
        if (!drawer) return false;

        try {
            drawer.remove(); // 从 DOM 中移除
            // 可选：等待确保元素彻底消失
            await waitForElementDisappear('.core-drawer', 5000, 100)
                .catch(() => { }); // 超时忽略
            console.log('弹窗已被销毁');
            return true;
        } catch (err) {
            console.error('销毁弹窗失败', err);
            return false;
        }
    }

    async function closeDrawerWithRetry(drawer, maxRetries = 3, interval = 500) {
        const closeBtn = drawer.querySelector('.core-drawer-close-icon');
        if (!closeBtn) {
            console.warn('找不到关闭按钮');
            return false;
        }

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            closeBtn.click();
            try {
                await waitForElementDisappear('.core-drawer', 10000, 100);
                console.log('弹窗已成功关闭');
                return true; // 成功关闭
            } catch (err) {
                console.warn(`尝试第 ${attempt} 次关闭弹窗失败`);
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, interval)); // 等待一段时间再重试
                }
            }
        }

        console.error('弹窗关闭失败，已达最大重试次数');
        return false;
    }



    function isRatingPage() {
        return location.href.startsWith("https://seller-us.tiktok.com/product/rating");
    }

    function isOrderPage() {
        return location.href.startsWith("https://seller-us.tiktok.com/order");
    }

    function isGlobalRatingPage() {
        return location.href.startsWith("https://seller.us.tiktokshopglobalselling.com/product/rating");
    }

    function isGlobalOrderPage() {
        return location.href.startsWith("https://seller.us.tiktokshopglobalselling.com/order");
    }

    function showRunningOverlay() {
        if (overlayEl) return; // 避免重复创建

        overlayEl = document.createElement("div");
        overlayEl.id = "running-overlay";
        Object.assign(overlayEl.style, {
            position: "fixed",
            top: "0",
            left: "0",
            width: "100%",
            height: "100%",
            backgroundColor: "rgba(0,0,0,0.6)",
            color: "#fff",
            fontSize: "24px",
            fontWeight: "bold",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            zIndex: 999999998, // 比面板低一层
            userSelect: "none",
            pointerEvents: "all"
        });
        overlayEl.innerText = "脚本运行中，请勿操作";

        document.body.style.overflow = "hidden"; // 禁止滚动
        document.body.appendChild(overlayEl);
    }

    function hideRunningOverlay() {
        if (!overlayEl) return;
        overlayEl.remove();
        overlayEl = null;
        document.body.style.overflow = ""; // 恢复滚动
    }

    function getCurrentSite() {
        const hostname = window.location.hostname;

        // 精确匹配两个站点
        if (hostname === "seller-us.tiktok.com") {
            return "tiktok_us_seller"; // 美国本土卖家站点
        }

        if (hostname === "seller.us.tiktokshopglobalselling.com") {
            return "tiktok_global_seller"; // 全球卖家站点
        }

        // 如果是其他 TikTok 卖家子域名
        if (hostname.includes("tiktok.com")) {
            return "other_tiktok_seller";
        }

        return "unknown";
    }

    // =======================
    // ====== Excel 导出 ======
    // =======================
    function exportToExcel(data) {
        if (!data || data.length === 0) {
            throw "错误：没有获取到任何数据";
        }

        const ws = XLSX.utils.aoa_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Ratings");

        const fileName = `ratings_${dayjs().format("YYYYMMDD_HHmmss")}.xlsx`;
        XLSX.writeFile(wb, fileName);
    }

    async function exportExcel() {
        showRunningOverlay();

        try {
            const site = getCurrentSite();

            const siteConfig = {
                tiktok_us_seller: {
                    isRatingPage,
                    isOrderPage,
                    ratingUrl: "https://seller-us.tiktok.com/product/rating",
                    orderUrl: "https://seller-us.tiktok.com/order",
                },
                tiktok_global_seller: {
                    isRatingPage: isGlobalRatingPage,
                    isOrderPage: isGlobalOrderPage,
                    ratingUrl: "https://seller.us.tiktokshopglobalselling.com/product/rating",
                    orderUrl: "https://seller.us.tiktokshopglobalselling.com/order",
                },
            };

            const config = siteConfig[site];
            if (!config) return;

            const headers = [
                "Order ID",
                "Order Time",
                "Product ID",
                "Product Name",
                "Sku ID",
                "Sku Name",
                "Rating",
                "Review Time",
                "Reviews (Text)"
            ];

            /** 评分页：采集数据 → 跳转订单页 */
            if (config.isRatingPage() && isWorking) {
                await processAllPages(processLists);

                const rows = tableData.map(r => [
                    r.orderId,
                    r.orderTime,
                    r.productId,
                    r.productName,
                    r.skuId,
                    r.skuName,
                    r.rating,
                    r.reviewTime,
                    r.reviewText
                ]);

                await setTableData([headers, ...rows]);
                window.location.href = config.orderUrl;
                return;
            }

            /** 订单页：补订单时间 → 导出 */
            if (config.isOrderPage() && isWorking && tableData.length > 0) {
                await fillSearchInBatches(tableData);
                exportToExcel(tableData);
                await reset();
                alert("导出完成，请查看浏览器下载页");
                return;
            }

            /** 兜底：跳转评分页 */
            window.location.href = config.ratingUrl;

        } catch (err) {
            alert(err);
            await setWorking(false);
        } finally {
            hideRunningOverlay();
        }
    }


    async function fillSearchInBatches(dataTable, batchSize = 10, delay = 1000) {
        for (let i = 1; i < dataTable.length; i += batchSize) {
            const batchEnd = Math.min(i + batchSize, dataTable.length);
            const batch = dataTable.slice(i, batchEnd);
            const text = batch
                .map(row => row[0])
                .filter(id => /^\d+$/.test(id)) // 只保留纯数字
                .join(";");

            try {
                await waitForElementDisappear(".core-spin-icon", 30000, 100);
            } catch (err) {
                console.warn(err.message);
            }

            await waitForElement('input[data-tid="m4b_input_search"]', 120000, 1000)
            const input = document.querySelector('input[data-tid="m4b_input_search"]');
            if (!input) {
                console.warn("找不到输入框");
                return;
            }

            // React onChange
            const reactFiber = input._reactInternals || input[Object.keys(input).find(k => k.startsWith("__reactInternalInstance"))];
            if (reactFiber?.memoizedProps?.onChange) {
                reactFiber.memoizedProps.onChange({ target: { value: text } });
            }

            // 发送 Enter
            input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }));
            input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }));

            await sleep(1000)
            // 等待加载完成
            try {
                await waitForElementDisappear(".core-spin-icon", 30000, 100);
            } catch (err) {
                console.warn(err.message);
            }

            // 获取订单时间映射
            const orderTimeMap = extractOrderTimeMap();

            // 回写到原数组
            for (let j = i; j < batchEnd; j++) {
                const orderId = dataTable[j][0];
                dataTable[j][1] = orderTimeMap[orderId] || null;
            }

            // 延迟下一批次
            if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        }
    }


    /**
     * 等待指定 selector 的元素消失（display:none 或不在 DOM 中）
     * @param {string} selector - 要等待消失的元素选择器
     * @param {number} timeout - 超时时间，毫秒
     * @param {number} interval - 检查间隔，毫秒
     */
    function waitForElementDisappear(selector, timeout = 5000, interval = 100) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const timer = setInterval(() => {
                const el = document.querySelector(selector);
                if (!el || getComputedStyle(el).display === "none") {
                    clearInterval(timer);
                    resolve();
                } else if (Date.now() - start > timeout) {
                    clearInterval(timer);
                    reject(new Error(`等待元素消失超时: ${selector}`));
                }
            }, interval);
        });
    }


    function extractOrderTimeMap() {
        const map = {}; // { orderId: timeString }

        // 每条订单外层块（通过实际结构调整 selector）
        const items = document.querySelectorAll('[data-id="fulfillment.manage_order.order_list_table.order_id"]');

        items.forEach(item => {
            // 找到 orderId
            const orderEl = item.querySelector('[data-log_click_for="order_id_link"]');
            if (!orderEl) return;

            const orderId = orderEl.textContent.trim();

            // 用 item 的全部文本去掉 orderId，剩下的就是时间
            let orderTime = item.textContent.replace(orderId, "").trim();
            // const parsedDate = dayjs(orderTime, 'MM/DD/YYYY h:mm:ss A');
            // const formattedDate = parsedDate.format('YYYY-MM-DD HH:mm:ss');
            map[orderId] = orderTime;
        });
        return map;
    }

    /**
     * 获取分页容器
     */
    function getPagination() {
        return document.querySelector('.core-pagination-list');
    }

    /**
     * 获取所有页码元素（不包含上一页/下一页按钮）
     */
    function getPageItems() {
        const pagination = getPagination();
        if (!pagination) return [];
        return Array.from(pagination.querySelectorAll('.core-pagination-item'))
            .filter(el => !el.classList.contains('core-pagination-item-prev') && !el.classList.contains('core-pagination-item-next'));
    }

    /**
     * 获取当前页码（数字）
     */
    function getCurrentPage() {
        const active = getPageItems().find(el => el.classList.contains('core-pagination-item-active'));
        return active ? parseInt(active.textContent.trim(), 10) : null;
    }

    /**
     * 判断是否有下一页
     */
    function hasNextPage() {
        const pagination = getPagination();
        if (!pagination) return false;
        const nextBtn = pagination.querySelector('.core-pagination-item-next');
        return nextBtn && !nextBtn.classList.contains('core-pagination-item-disabled');
    }

    /**
     * 判断是否有上一页
     */
    function hasPrevPage() {
        const pagination = getPagination();
        if (!pagination) return false;
        const prevBtn = pagination.querySelector('.core-pagination-item-prev');
        return prevBtn && !prevBtn.classList.contains('core-pagination-item-disabled');
    }

    /**
     * 跳转到指定页
     */
    function goToPage(pageNumber) {
        const pages = getPageItems();
        const target = pages.find(el => parseInt(el.textContent.trim(), 10) === pageNumber);
        if (target) {
            target.click();
            console.log(`跳转到第 ${pageNumber} 页`);
            return true;
        }
        console.warn(`找不到第 ${pageNumber} 页`);
        return false;
    }

    /**
     * 下一页
     */
    function nextPage() {
        if (hasNextPage()) {
            const nextBtn = getPagination().querySelector('.core-pagination-item-next');
            nextBtn.click();
            console.log('跳转到下一页');
            return true;
        }
        console.warn('已经是最后一页');
        return false;
    }

    /**
     * 上一页
     */
    function prevPage() {
        if (hasPrevPage()) {
            const prevBtn = getPagination().querySelector('.core-pagination-item-prev');
            prevBtn.click();
            console.log('跳转到上一页');
            return true;
        }
        console.warn('已经是第一页');
        return false;
    }

    async function processLists(lists) {
        for (let index = 0; index < lists.length; index++) {
            const list = lists[index];
            console.log(`===== 第 ${index + 1} 个 rating-list =====`);

            // 遍历一级子元素
            for (let i = 0; i < list.children.length; i++) {

                if (!isWorking) {
                    break;
                }

                const child = list.children[i];
                console.log(`  子元素 ${i + 1}:`, child);

                // 计算星星数量
                const starCount = child.querySelectorAll('.activeStar-OiHELX').length;
                console.log(starCount);

                // 查找直接拥有 "Review details" 文本的元素
                let reviews = []
                try {
                    reviews = await getReviews(child, reviews);
                } catch {
                    sleep(3000)
                    reviews = await getReviews(child, reviews);
                }

                // Order ID
                const orderElem = child.querySelector('.productItemInfoOrderIdText-pbtT22');

                let orderId = ""
                if (orderElem) {
                    // 提取数字部分
                    const orderIdMatch = orderElem.textContent.match(/\d+/);
                    orderId = orderIdMatch ? orderIdMatch[0] : null;
                    console.log('Order ID:', orderId);
                } else {
                    console.warn('找不到 orderId 元素');
                }

                // Product ID
                const productElem = child.querySelector('.productItemInfoProductId-MNDZzz');

                let productId = ""
                if (productElem) {
                    // 提取数字部分
                    const productIdMatch = productElem.textContent.match(/\d+/);
                    productId = productIdMatch ? productIdMatch[0] : null;
                    console.log('Product ID:', productId);
                } else {
                    console.warn('找不到 productId 元素');
                }

                addRecord({
                    orderTime: "",
                    productId,
                    orderId,
                    rating: starCount,
                    reviewTime: reviews[0]?.time ?? "",
                    reviewText: reviews[0]?.content ?? ""
                })

                updateDataCount()
            }
        }

        async function getReviews(child, reviews) {
            const target = Array.from(child.querySelectorAll('*'))
                .find(el => el.childElementCount === 0 && (el.textContent.trim() === "Review details" || el.textContent.trim() === "评价详情"));

            if (target) {
                target.click(); // 点击展开
                try {
                    reviews = await getReviewDetails(); // 等待抓取弹窗内容
                } catch (err) {
                    await sleep(3000)
                    try {
                        reviews = await getReviewDetails(); // 等待抓取弹窗内容
                    } catch (err) {
                        return []
                    }
                }
                console.log('抓取到的评论:', reviews);
                await sleep(300);
            } else {
                console.error("在子元素中找不到 Review details");
            }
            return reviews;
        }
    }

    async function processAllPages(processLists) {
        while (true) {
            if (!isWorking) {
                break;
            }
            // 获取当前页的列表元素
            await waitForElement('[data-tid="rating-list"]', 12000, 100)
            const lists = document.querySelectorAll('[data-tid="rating-list"]');
            if (!lists.length) {
                console.warn('当前页没有列表元素');
                break;
            }

            // 处理当前页的列表
            await processLists(lists);

            // 如果没有下一页，结束循环
            if (!hasNextPage()) {
                console.log('已经是最后一页，处理完成');
                break;
            }

            // 跳转到下一页
            nextPage();

            // 等待页面 DOM 刷新，可以适当延迟
            await new Promise(resolve => setTimeout(resolve, 1500));
        }
    }

    // 更新按钮状态
    async function setWorking(flag) {
        isWorking = flag;
        await GM.setValue("isWorking", flag);
        const btn = document.querySelector("#btn-export-xlsx");
        if (!btn) return;
        if (flag) {
            btn.innerHTML = `<span class="spinner"></span>处理中...`;
            btn.disabled = true;
        } else {
            btn.innerHTML = "导出 Excel";
            btn.disabled = false;
        }
    }


    function createFloatingPanel() {
        const panel = document.createElement("div");
        panel.id = "export-panel";
        panel.style.zIndex = "9999"

        panel.innerHTML = `
        <div style="
            font-size: 14px;
            font-weight: bold;
            margin-bottom: 8px;
        ">评价数据导出</div>
        <div id="data-count" style="
            font-size:12px;
            margin-bottom:8px;
            color:#333;
        ">已抓取：0 条</div>
        <button id="btn-export-xlsx" style="
            display: block;
            width: 100%;
            padding: 6px 10px;
            background: #4CAF50;
            border: none;
            color: white;
            border-radius: 4px;
            cursor: not-allowed;
        " disabled>导出 Excel</button>
            <button id="btn-reset" style="
        margin-top:8px;
        width:100%;
        padding:6px 10px;
        background:#f44336;
        border:none;
        color:white;
        border-radius:4px;
        cursor:pointer;
    ">重置</button>
    `;

        Object.assign(panel.style, {
            position: "fixed",
            top: "100px",
            right: "40px",
            width: "150px",
            padding: "12px",
            background: "white",
            border: "1px solid #ccc",
            borderRadius: "8px",
            zIndex: 999999999,
            boxShadow: "0 4px 10px rgba(0,0,0,0.15)",
            cursor: "move",
            userSelect: "none"
        });

        document.body.appendChild(panel);

        const btn = document.querySelector("#btn-export-xlsx");

        window.addEventListener("load", () => {
            btn.disabled = false;
            btn.style.cursor = "pointer";
            btn.onclick = async () => {
                if (isWorking) return;
                await setWorking(true)
                await exportExcel(); // 这里放你的导出逻辑
            };
        });

        document.querySelector("#btn-reset").onclick = reset;

        makeDraggable(panel);

        // spinner 动画
        const style = document.createElement("style");
        style.innerHTML = `
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        .spinner {
            display:inline-block;
            width:16px;
            height:16px;
            border:2px solid #fff;
            border-top:2px solid #4CAF50;
            border-radius:50%;
            animation: spin 1s linear infinite;
            margin-right:6px;
        }
    `;
        document.head.appendChild(style);
    }

    function updateDataCount() {
        const el = document.querySelector("#data-count");
        if (el) el.textContent = `已抓取：${tableData.length} 条`;
    }

    // ====== 实现可拖动功能 ======
    function makeDraggable(el) {
        let offsetX = 0;
        let offsetY = 0;
        let dragging = false;

        el.addEventListener("mousedown", (e) => {
            dragging = true;
            offsetX = e.clientX - el.offsetLeft;
            offsetY = e.clientY - el.offsetTop;
            el.style.transition = "none";
        });

        document.addEventListener("mousemove", (e) => {
            if (!dragging) return;
            el.style.left = e.clientX - offsetX + "px";
            el.style.top = e.clientY - offsetY + "px";
        });

        document.addEventListener("mouseup", () => {
            dragging = false;
        });
    }

    async function init() {
        createFloatingPanel();
        await initTableData()
        await initWorkingState()
        if (isWorking) {
            showRunningOverlay();
        }
        updateDataCount()
    }


    // ====== 页面加载后初始化 ======
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", async () => {
            await init()
        });
    } else {
        await init()
    }

    window.addEventListener("load", async () => {
        if (isWorking) {
            showRunningOverlay();
            console.log("运行中，继续执行")
            await exportExcel()
        }
    })
})();