/** @odoo-module **/

import { Component, onMounted, onPatched, useRef } from "@odoo/owl";

const ISO_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

function pad(number) {
    return String(number).padStart(2, "0");
}

/** يتحقّق أن التاريخ موجود فعلاً (31 شباط مثلاً مرفوض) ويعيده بصيغة النظام */
function buildIso(year, month, day) {
    if (!year || !month || !day || month < 1 || month > 12 || day < 1 || day > 31) {
        return null;
    }
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
        return null;
    }
    return `${year}-${pad(month)}-${pad(day)}`;
}

/** صيغة النظام (yyyy-mm-dd) ← ما يُعرض للمستخدم (dd/mm/yyyy) */
export function isoToDisplay(iso) {
    const match = ISO_RE.exec((iso || "").slice(0, 10));
    return match ? `${pad(match[3])}/${pad(match[2])}/${match[1]}` : "";
}

/**
 * ما يكتبه المستخدم ← صيغة النظام.
 * يقبل 5/8/2025 و 05-08-2025 و 05082025 و 5/8 (سنة هذا العام) و 5/8/25،
 * ويعيد "" للخانة الفارغة و null لما لا يُفهم.
 */
export function parseDate(text) {
    const raw = (text || "").trim();
    if (!raw) {
        return "";
    }
    // تاريخ ملصوق بصيغة النظام
    const iso = ISO_RE.exec(raw);
    if (iso) {
        return buildIso(+iso[1], +iso[2], +iso[3]);
    }
    const parts = raw.split(/\D+/).filter(Boolean);
    let day;
    let month;
    let year;
    if (parts.length >= 2) {
        day = +parts[0];
        month = +parts[1];
        year = parts.length > 2 ? +parts[2] : new Date().getFullYear();
    } else {
        // أرقام متلاصقة بلا فواصل
        const digits = parts[0] || "";
        if (digits.length !== 8 && digits.length !== 6 && digits.length !== 4) {
            return null;
        }
        day = +digits.slice(0, 2);
        month = +digits.slice(2, 4);
        year = digits.length === 4 ? new Date().getFullYear() : +digits.slice(4);
    }
    if (year < 100) {
        year += 2000;
    }
    return buildIso(year, month, day);
}

/**
 * خانة تاريخ بصيغة يوم/شهر/سنة في كل صفحات النظام.
 *
 * خانة المتصفّح الأصلية (input type="date") تعرض الشهر أولاً حين تكون لغة
 * المتصفّح أمريكية، ولا سبيل لتغيير ذلك، فنكتب خانتنا: نص يُعرض ويُكتب
 * يوم/شهر/سنة، وزر نتيجة يفتح نتيجة المتصفّح لمن يفضّل الاختيار بالماوس.
 */
export class DateInput extends Component {
    static template = "my_accounting.DateInput";
    static props = {
        // القيمة قد تصل false من الخادم حين لا تاريخ، فنقبلها كما هي
        value: { type: [String, Boolean], optional: true },
        onChange: Function,
        onKeydown: { type: Function, optional: true },
        inputClass: { type: String, optional: true },
        width: { type: String, optional: true },
    };

    setup() {
        this.inputRef = useRef("input");
        this.pickerRef = useRef("picker");
        onMounted(() => this.syncFromProps());
        onPatched(() => this.syncFromProps());
    }

    get display() {
        return isoToDisplay(this.props.value);
    }

    get style() {
        return this.props.width ? `width:${this.props.width};` : "";
    }

    /**
     * الخانة نصّ يملكه المستخدم أثناء الكتابة، فلا نكتب فوقه إلا حين تتغيّر
     * القيمة من خارجها (تصحيح بضغطة، أو انتقال إلى قيد آخر).
     */
    syncFromProps() {
        const input = this.inputRef.el;
        if (input && document.activeElement !== input && input.value !== this.display) {
            input.value = this.display;
        }
    }

    // شرطة تلقائية أثناء الكتابة: 0508 تصبح 05/08
    onInput(ev) {
        const input = ev.target;
        if (input.selectionStart !== input.value.length) {
            return; // تعديل في وسط النص: لا نتدخّل
        }
        const digits = input.value.replace(/\D/g, "").slice(0, 8);
        if (input.value.replace(/\//g, "") !== digits) {
            return; // كتب فاصلاً آخر (نقطة أو شرطة) فنتركه حتى يُغادر الخانة
        }
        const pieces = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)];
        input.value = pieces.filter((piece) => piece !== "").join("/");
    }

    commit(ev) {
        const input = ev.target;
        const iso = parseDate(input.value);
        if (iso === null) {
            input.value = this.display; // غير مفهوم: نُرجع آخر تاريخ صحيح
            return;
        }
        input.value = isoToDisplay(iso);
        if (iso !== (this.props.value || "")) {
            this.props.onChange(iso);
        }
    }

    onKeydown(ev) {
        if (ev.key === "Enter") {
            this.commit(ev);
        }
        if (this.props.onKeydown) {
            this.props.onKeydown(ev);
        }
    }

    /** نتيجة المتصفّح: تعرض الشهر بالاسم فلا لبس في ترتيب الأرقام */
    openPicker() {
        const picker = this.pickerRef.el;
        if (!picker) {
            return;
        }
        picker.value = this.props.value || "";
        if (picker.showPicker) {
            picker.showPicker();
        } else {
            picker.focus();
            picker.click();
        }
    }

    onPicked(ev) {
        const iso = ev.target.value || "";
        if (this.inputRef.el) {
            this.inputRef.el.value = isoToDisplay(iso);
        }
        this.props.onChange(iso);
    }
}
