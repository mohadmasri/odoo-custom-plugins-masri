/** @odoo-module **/

import { Component, onMounted, onWillStart, onWillUnmount, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

const POLL_MS = 3000;

/**
 * صفحة تقدم القراءة الجماعية بـ Gemini: شريط عام (كم صورة انتهت) وحالة كل صورة
 * (المحاولة الحالية، العد التنازلي لإعادة المحاولة، النتيجة). القراءة نفسها تعمل على
 * الخادم، فيمكن مغادرة الصفحة والعودة إليها من القائمة لرؤية آخر دفعة.
 */
export class PhotoBatchPage extends Component {
    static template = "my_accounting.PhotoBatch";
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.actionService = useService("action");
        const context = (this.props.action && this.props.action.context) || {};
        this.batch = context.photo_batch || false;
        this.state = useState({ data: null, tick: 0 });
        onWillStart(() => this.load());
        onMounted(() => {
            this.timer = setInterval(() => this.poll(), POLL_MS);
            this.clock = setInterval(() => this.state.tick++, 1000);
        });
        onWillUnmount(() => {
            clearInterval(this.timer);
            clearInterval(this.clock);
        });
    }

    async load() {
        const data = await this.orm.call("myaccounting.photo.entry", "get_batch_status", [this.batch]);
        this.batch = data.batch;
        this.loadedAt = Date.now();
        this.state.data = data;
    }

    async poll() {
        if (this.state.data && (this.state.data.active || !this.state.data.total)) {
            await this.load();
        }
    }

    get percent() {
        const data = this.state.data;
        return data && data.total ? Math.round(((data.done + data.failed) / data.total) * 100) : 0;
    }

    // العد التنازلي محلياً بين كل تحديث وآخر
    retryIn(item) {
        this.state.tick; // يعيد الرسم كل ثانية
        const passed = Math.floor((Date.now() - this.loadedAt) / 1000);
        return Math.max(0, item.retry_in - passed);
    }

    statusText(item) {
        if (item.read_state === "running") {
            return `جارِ القراءة (المحاولة ${item.attempts})`;
        }
        if (item.read_state === "queued") {
            const wait = this.retryIn(item);
            return item.attempts
                ? (wait ? `إعادة المحاولة بعد ${wait} ثانية (فشلت ${item.attempts})` : `تُعاد المحاولة الآن (فشلت ${item.attempts})`)
                : "في الانتظار";
        }
        if (item.read_state === "done") {
            return `اكتملت: ${item.lines} بنود` + (item.uncertain ? ` · ${item.uncertain} تحتاج مراجعة` : "")
                + (item.balanced ? "" : " · غير متوازن");
        }
        return "توقفت";
    }

    async stop(ids) {
        await this.orm.call("myaccounting.photo.entry", "action_stop_read", [ids]);
        await this.load();
    }

    stopAll() {
        const ids = this.state.data.items
            .filter((item) => item.read_state === "queued" || item.read_state === "running")
            .map((item) => item.id);
        if (ids.length) {
            this.stop(ids);
        }
    }

    open(id) {
        this.actionService.doAction({
            type: "ir.actions.act_window",
            res_model: "myaccounting.photo.entry",
            res_id: id,
            views: [[false, "form"]],
            target: "current",
        });
    }

    openList() {
        this.actionService.doAction("my_accounting.action_myaccounting_photo_entries");
    }
}

registry.category("actions").add("my_accounting.photo_batch", PhotoBatchPage);
