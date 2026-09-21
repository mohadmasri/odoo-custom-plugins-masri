/** @odoo-module **/

import { Component, onMounted, onWillUnmount, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { standardFieldProps } from "@web/views/fields/standard_field_props";

const POLL_MS = 2000;
// متوسط زمن الرد (ثوانٍ) لتقدير تقدّم خطوة "انتظار الرد"
const EXPECTED_SECONDS = { claude: 70, gemini: 20 };

/**
 * شريط تقدم قراءة صورة القيد. القراءة تعمل على الخادم في الخلفية، وهذا الحقل يسأل
 * الخادم عن حالتها كل ثانيتين ويعرض خطواتها؛ وعند انتهائها يعيد تحميل القيد لتظهر البنود.
 */
export class ReadProgressField extends Component {
    static template = "my_accounting.ReadProgress";
    static props = { ...standardFieldProps };

    setup() {
        this.orm = useService("orm");
        this.state = useState({ now: Date.now() });
        onMounted(() => {
            this.timer = setInterval(() => this.tick(), POLL_MS);
        });
        onWillUnmount(() => clearInterval(this.timer));
    }

    get data() {
        return this.props.record.data;
    }

    get active() {
        return ["queued", "running"].includes(this.data.read_state);
    }

    get providerName() {
        return this.data.read_provider === "gemini" ? "Gemini" : "Claude";
    }

    get steps() {
        return [
            "تجهيز الصورة",
            `إرسال الصورة وانتظار رد ${this.providerName}`,
            "تحليل الرد ومطابقة الحسابات",
            "حفظ البنود",
        ];
    }

    // 1..4 = الخطوة الجارية، 5 = اكتملت
    stepStatus(index) {
        const step = this.data.read_step || 0;
        const number = index + 1;
        if (this.data.read_state === "done" || step > number) {
            return "done";
        }
        if (step === number) {
            return this.data.read_state === "failed" ? "failed" : "current";
        }
        return "pending";
    }

    // ثوانٍ حتى إعادة المحاولة التالية (القراءة الجماعية)
    get retryIn() {
        const next = this.data.read_next_try;
        return next ? Math.max(0, Math.round((next.toMillis() - this.state.now) / 1000)) : 0;
    }

    get elapsed() {
        const started = this.data.read_started;
        if (!started) {
            return 0;
        }
        const end = this.active ? this.state.now : (this.data.read_finished?.toMillis() || this.state.now);
        return Math.max(0, Math.round((end - started.toMillis()) / 1000));
    }

    get percent() {
        const step = this.data.read_step || 0;
        if (this.data.read_state === "done") {
            return 100;
        }
        if (this.data.read_state === "queued" || step === 0) {
            return 2;
        }
        if (step === 1) {
            return 5;
        }
        if (step === 2) {
            // انتظار الرد هو الجزء الأطول: نقدّره بالزمن حتى 85%
            const expected = EXPECTED_SECONDS[this.data.read_provider] || 60;
            return Math.min(85, 8 + Math.round((this.elapsed / expected) * 77));
        }
        return step === 3 ? 90 : 96;
    }

    async tick() {
        this.state.now = Date.now();
        if (!this.active || !this.props.record.resId) {
            return;
        }
        const [fresh] = await this.orm.read(this.props.record.resModel, [this.props.record.resId],
            ["read_state", "read_step", "read_attempts"]);
        if (!fresh) {
            return;
        }
        if (fresh.read_state !== this.data.read_state || fresh.read_step !== this.data.read_step
                || fresh.read_attempts !== this.data.read_attempts) {
            // تغيّرت الحالة: نعيد تحميل القيد (تظهر البنود عند الانتهاء)
            await this.props.record.load();
        }
    }
}

registry.category("fields").add("myaccounting_read_progress", {
    component: ReadProgressField,
    supportedTypes: ["selection"],
});
