// ==UserScript==
// @name         Nextiva Missed Call Collector
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Collect missed call records from Nextiva
// @match        https://kwickpos.nextos.com/apps/nextiva-connect*
// @grant        none
// ==/UserScript==

class CallRecord {
    constructor(timestamp, phoneNumber, dataIndex) {
        this.timestamp = timestamp;
        this.phoneNumber = phoneNumber;
        this.dataIndex = dataIndex;
    }
}

class NextivaCollector {
    constructor() {
        this.debug = true;
        this.isCollecting = false;
        this.allRecords = [];
        this.processedIndexes = new Set();
        this.maxProcessedIndex = -1;
        this.lastKnownRowCount = 0;
    }

    log(message, data = null) {
        if (this.debug) {
            console.log(`[Nextiva Collector] ${message}`, data || '');
        }
    }

    parseDateTime(text) {
        const now = new Date();
        let date = new Date();

        // Handle time-only format (for today)
        const timeOnlyMatch = text.match(/^(\d{1,2}):(\d{2})\s*([AP]M)?/i);
        if (timeOnlyMatch) {
            let hours = parseInt(timeOnlyMatch[1]);
            const minutes = parseInt(timeOnlyMatch[2]);
            const period = timeOnlyMatch[3]?.toUpperCase();

            if (period === 'PM' && hours !== 12) hours += 12;
            if (period === 'AM' && hours === 12) hours = 0;

            date.setHours(hours, minutes, 0, 0);
            return date;
        }

        // Handle "Yesterday" format
        const yesterdayMatch = text.match(/Yesterday\s*(\d{1,2}):(\d{2})(?:\s*([AP]M))?/i);
        if (yesterdayMatch) {
            date.setDate(date.getDate() - 1);

            let hours = parseInt(yesterdayMatch[1]);
            const minutes = parseInt(yesterdayMatch[2]);
            const period = yesterdayMatch[3]?.toUpperCase();

            if (period === 'PM' && hours !== 12) hours += 12;
            if (period === 'AM' && hours === 12) hours = 0;

            date.setHours(hours, minutes, 0, 0);
            return date;
        }

        this.log('Date text does not match expected patterns:', text);
        return null;
    }

    isWithinTimeRange(dateText) {
        // Check if it's just a time (today)
        if (/^\d{1,2}:\d{2}\s*[AP]M?/i.test(dateText)) {
            return true;
        }

        // Check if it's yesterday
        if (/^Yesterday/i.test(dateText)) {
            return true;
        }

        return false;
    }

    async collectRecords() {
        const rows = document.querySelectorAll('[data-testid="CommunicationsUI-Compact-View-Message-queue-card"]');
        this.lastKnownRowCount = rows.length;
        this.log(`Found ${rows.length} message rows`);
        let newRecordsCount = 0;
        let foundOldRecord = false;
        let missingIndexes = [];

        // First, check for any gaps in our processed indexes
        const currentIndexes = new Set();
        rows.forEach(row => {
            const parentElement = row.closest('[data-index]');
            if (parentElement) {
                const dataIndex = parseInt(parentElement.getAttribute('data-index'));
                currentIndexes.add(dataIndex);
            }
        });

        // Check for missing indexes between 0 and the highest index we've seen
        for (let i = 0; i <= Math.max(...currentIndexes); i++) {
            if (!currentIndexes.has(i) && !this.processedIndexes.has(i.toString())) {
                missingIndexes.push(i);
            }
        }

        if (missingIndexes.length > 0) {
            this.log('Missing indexes detected:', missingIndexes);
        }

        for (const row of rows) {
            const parentElement = row.closest('[data-index]');
            if (!parentElement) {
                this.log('Warning: Found row without data-index');
                continue;
            }

            const dataIndex = parentElement.getAttribute('data-index');
            const numericIndex = parseInt(dataIndex);

            // Update max processed index
            this.maxProcessedIndex = Math.max(this.maxProcessedIndex, numericIndex);

            if (this.processedIndexes.has(dataIndex)) {
                continue;
            }

            // 检查是否为未接来电
            if (!row.textContent.includes('Missed call')) {
                this.processedIndexes.add(dataIndex); // Mark non-missed calls as processed
                continue;
            } else {
                this.log('Missed call:', row.querySelector('[data-testid="CommunicationsUI-Compact-View-sender"]').textContent.trim() + ", "+ row.querySelector('[data-testid="CommunicationsUI-Compact-View-timestamp"]').textContent);
            }

            const timestampElement = row.querySelector('[data-testid="CommunicationsUI-Compact-View-timestamp"]');
            if (!timestampElement) continue;

            if (!this.isWithinTimeRange(timestampElement.textContent)) {
                foundOldRecord = true;
                this.processedIndexes.add(dataIndex); // Mark old records as processed
                continue;
            }

            const phoneElement = row.querySelector('[data-testid="CommunicationsUI-Compact-View-sender"]');
            if (!phoneElement) continue;

            let phoneNumber = phoneElement.textContent.trim();
            const phoneMatch = phoneNumber.match(/\+?1?\s*\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/);
            if (!phoneMatch) continue;
            phoneNumber = `(${phoneMatch[1]})${phoneMatch[2]}-${phoneMatch[3]}`;

            const timestamp = this.parseDateTime(timestampElement.textContent);
            if (!timestamp) continue;

            this.allRecords.push(new CallRecord(timestamp, phoneNumber, dataIndex));
            this.processedIndexes.add(dataIndex);
            newRecordsCount++;

            this.log('Added record:', {
                phoneNumber,
                timestamp: timestamp.toLocaleString(),
                dataIndex
            });
        }

        // Log collection statistics
        this.log('Collection statistics:', {
            totalRows: this.lastKnownRowCount,
            processedIndexes: this.processedIndexes.size,
            maxProcessedIndex: this.maxProcessedIndex,
            missingIndexes: missingIndexes
        });

        return {
            newRecordsCount,
            foundOldRecord,
            missingIndexes: missingIndexes.length > 0
        };
    }

    generateReport() {
        // 首先按时间排序记录（最新的在前）
        const sortedRecords = this.allRecords.sort((a, b) => b.timestamp - a.timestamp);

        // 用于存储合并后的记录
        const mergedRecords = new Map(); // key: phoneNumber_hourTimestamp

        // 处理每条记录
        for (const record of sortedRecords) {
            // 获取这条记录所在的小时时间戳（将分钟、秒、毫秒都设为0）
            const hourTimestamp = new Date(record.timestamp);
            hourTimestamp.setMinutes(0, 0, 0);

            // 创建唯一键，用于标识同一个电话号码在同一小时内的记录
            const key = `${record.phoneNumber}_${hourTimestamp.getTime()}`;

            if (mergedRecords.has(key)) {
                // 如果已经存在这个小时内的记录，增加计数
                const existingRecord = mergedRecords.get(key);
                existingRecord.callsInHour += 1;
            } else {
                // 如果是这个小时内的第一条记录
                mergedRecords.set(key, {
                    timestamp: record.timestamp, // 保持原始时间戳
                    phoneNumber: record.phoneNumber,
                    callsInHour: 1
                });
            }
        }

        // 转换合并后的记录为数组，并再次按时间排序
        const report = Array.from(mergedRecords.values()).map(record => {
            const hour = record.timestamp.getHours();
            const ampm = hour >= 12 ? 'pm' : 'am';
            const hour12 = hour === 0 ? 12 : (hour > 12 ? hour - 12 : hour);
            const datetime = `${record.timestamp.getMonth() + 1}/${
            record.timestamp.getDate()}/${
            record.timestamp.getFullYear()} ${
            hour12}:${record.timestamp.getMinutes().toString().padStart(2, '0')} ${ampm}`;

            return {
                datetime: datetime,
                phoneNumber: record.phoneNumber,
                callsInHour: record.callsInHour
            };
        });

        // 按时间倒序排列
        return report.sort((a, b) => b.datetime.localeCompare(a.datetime));
    }

    async downloadCSV() {
        const report = this.generateReport();

        if (report.length === 0) {
            alert('没有找到未接来电记录。');
            return;
        }

        const csv = [
            ['DateTime', 'Phone Number', 'Calls in Hour'].join(','),
            ...report.map(row => [
                row.datetime,
                row.phoneNumber,
                row.callsInHour
            ].join(','))
        ].join('\n');

        const blob = new Blob([csv], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.setAttribute('hidden', '');
        a.setAttribute('href', url);

        const now = new Date();
        const dateStr = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}`;
        a.setAttribute('download', `Missed_call_records_${dateStr}.csv`);

        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    async autoScrollAndCollect() {
        if (this.isCollecting) return;
        this.isCollecting = true;

        const possibleContainers = [
            '.infinite-scroll-component',
            '[role="grid"]',
            '.MuiBox-root > div',
            'main',
            '#root > div > div'
        ];

        let scrollContainer = null;
        for (const selector of possibleContainers) {
            const container = document.querySelector(selector);
            if (container && container.scrollHeight > container.clientHeight) {
                scrollContainer = container;
                break;
            }
        }

        if (!scrollContainer) {
            const allDivs = document.getElementsByTagName('div');
            let maxScrollHeight = 0;

            for (const div of allDivs) {
                if (div.scrollHeight > div.clientHeight && div.scrollHeight > maxScrollHeight) {
                    scrollContainer = div;
                    maxScrollHeight = div.scrollHeight;
                }
            }
        }

        if (!scrollContainer) {
            alert('无法找到可滚动的容器，请确保页面已完全加载。');
            this.isCollecting = false;
            return;
        }

        const statusText = document.createElement('div');
        statusText.style.cssText = `
        position: fixed;
        top: 60px;
        right: 10px;
        background: rgba(0, 0, 0, 0.8);
        color: white;
        padding: 10px;
        border-radius: 4px;
        z-index: 9999;
        font-size: 14px;
    `;
        document.body.appendChild(statusText);

        let lastScrollTop = 0;
        let unchangedScrollCount = 0; // 追踪滚动位置未改变的次数
        let foundAnyInTimeRange = false; // 是否在当前批次中找到任何符合时间范围的记录

        while (this.isCollecting) {
            const initialRecordCount = this.allRecords.length;
            const startScrollTop = scrollContainer.scrollTop;
            foundAnyInTimeRange = false;

            // 检查当前可见的记录
            const rows = document.querySelectorAll('[data-testid="CommunicationsUI-Compact-View-Message-queue-card"]');
            for (const row of rows) {
                const timestampElement = row.querySelector('[data-testid="CommunicationsUI-Compact-View-timestamp"]');
                if (timestampElement && this.isWithinTimeRange(timestampElement.textContent)) {
                    foundAnyInTimeRange = true;
                    break;
                }
            }

            const { newRecordsCount } = await this.collectRecords();

            statusText.textContent = `正在收集未接来电...
已收集 ${this.allRecords.length} 条未接来电记录
已处理 ${this.processedIndexes.size} 条记录`;

            // 如果在当前可见区域没有找到任何符合时间范围的记录，并且滚动位置没有改变
            if (!foundAnyInTimeRange && scrollContainer.scrollTop === startScrollTop) {
                unchangedScrollCount++;
                // 如果连续3次都没有新的滚动且没有找到符合时间范围的记录，则停止
                if (unchangedScrollCount >= 3) {
                    this.log('No more scrolling possible and no recent records found, stopping collection');
                    break;
                }
            } else {
                unchangedScrollCount = 0; // 重置计数器
            }

            const scrollStep = Math.min(500, scrollContainer.clientHeight * 0.6);
            const targetScrollTop = lastScrollTop + scrollStep;

            try {
                await new Promise((resolve) => {
                    scrollContainer.scrollTo({
                        top: targetScrollTop,
                        behavior: 'smooth'
                    });
                    setTimeout(resolve, 300);
                });

                lastScrollTop = scrollContainer.scrollTop;

                // 给内容加载的时间
                await new Promise(resolve => setTimeout(resolve, 500));

            } catch (e) {
                this.log('Scroll error:', e);
                scrollContainer.scrollTop = targetScrollTop;
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        this.isCollecting = false;
        // 最后再收集一次确保不遗漏
        await this.collectRecords();

        statusText.textContent = `收集完成！
共收集 ${this.allRecords.length} 条未接来电记录`;

        await this.downloadCSV();

        // 2秒后刷新页面
        setTimeout(() => {
            window.location.reload();
        }, 2000);
    }

    addButton() {
        const button = document.createElement('button');
        button.textContent = '收集未接来电';
        button.style.cssText = `
            position: fixed;
            top: 10px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 9999;
            padding: 8px 16px;
            background-color: #3498db;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            transition: background-color 0.3s;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        `;

        button.onmouseover = () => {
            button.style.backgroundColor = '#2980b9';
        };

        button.onmouseout = () => {
            button.style.backgroundColor = '#3498db';
        };

        button.onclick = async () => {
            if (this.isCollecting) {
                this.isCollecting = false;
                button.textContent = '收集未接来电';
            } else {
                this.allRecords = [];
                this.processedIndexes.clear();
                button.textContent = '停止收集';
                await this.autoScrollAndCollect();
                button.textContent = '收集未接来电';
            }
        };

        document.body.appendChild(button);
    }
}

(function() {
    'use strict';
    console.log('Nextiva Collector script starting...');
    const collector = new NextivaCollector();

    window.addEventListener('load', () => {
        setTimeout(() => collector.addButton(), 1000);
    });
})();
