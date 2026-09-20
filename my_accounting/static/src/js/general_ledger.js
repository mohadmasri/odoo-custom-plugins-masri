/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

const STATE_FILTERS = [
    { value: "posted", label: "مرحّل" },
    { value: "draft", label: "مسودة" },
    { value: "incomplete", label: "غير مكتمل" },
];

function pad(n) {
    return String(n).padStart(2, "0");
}

function currentMonth() {
    const now = new Date();
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
}

export class GeneralLedger extends Component {
    static template = "my_accounting.GeneralLedger";
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.actionService = useService("action");
        this.state = useState({
            month: currentMonth(),
            data: null,
            loading: true,
            // فلتر الحالة (اختيار متعدد مثل صفحة القيود): مرحّل فقط افتراضياً
            states: ["posted"],
        });
        this.stateFilters = STATE_FILTERS;
        onWillStart(() => this.loadData());
    }

    get yearMonth() {
        const [y, m] = this.state.month.split("-").map(Number);
        return { y, m };
    }

    async loadData() {
        this.state.loading = true;
        const { y, m } = this.yearMonth;
        this.state.data = await this.orm.call(
            "myaccounting.move",
            "get_general_ledger_matrix",
            [y, m, this.state.states]
        );
        this.state.loading = false;
    }

    onMonthChange(ev) {
        this.state.month = ev.target.value;
        this.loadData();
    }

    shiftMonth(delta) {
        const [y, m] = this.state.month.split("-").map(Number);
        const d = new Date(y, m - 1 + delta, 1);
        this.state.month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
        this.loadData();
    }

    isStateActive(value) {
        return this.state.states.includes(value);
    }

    onStateFilter(value) {
        const states = this.isStateActive(value)
            ? this.state.states.filter((state) => state !== value)
            : [...this.state.states, value];
        // لا يمكن إلغاء كل الحالات: نُبقي "مرحّل" على الأقل
        this.state.states = states.length ? states : ["posted"];
        this.loadData();
    }

    openMove(id) {
        const rows = (this.state.data && this.state.data.rows) || [];
        this.actionService.doAction(
            {
                type: "ir.actions.act_window",
                res_model: "myaccounting.move",
                res_id: id,
                views: [[false, "form"]],
                target: "current",
            },
            { props: { resIds: rows.map((row) => row.move_id) } }
        );
    }

    // عرض النص داخل خلية (بدون تأثير عرض العمود)
    _textWidth(cell) {
        const range = document.createRange();
        range.selectNodeContents(cell);
        const width = range.getBoundingClientRect().width;
        range.detach();
        return width;
    }

    /**
     * الطباعة في صفحة A4 أفقية واحدة، مملوءة قدر الإمكان:
     *  1) تُضيَّق أعمدة الأرقام إلى أقل عرض يكفي أطول رقم (وتبقى كلها متساوية)،
     *     ويُسمح بالتفاف الترويسات وعمود المرجع، فيقلّ عرض الجدول.
     *  2) يُكبَّر الجدول (أو يُصغَّر) بالنسبة التي تملأ الصفحة دون تجاوزها،
     *     فتصبح الأرقام أكبر وأوضح.
     *  3) إن بقي فراغ رأسي، تُزاد المسافات داخل الصفوف لملء الصفحة.
     * كل ذلك يُطبَّق لحظة الطباعة فقط ثم يُلغى.
     */
    printLedger() {
        const page = document.querySelector(".o_general_ledger");
        const printable = page && page.querySelector(".o_gl_printable");
        const table = printable && printable.querySelector(".o_gl_table");
        if (!table) {
            window.print();
            return;
        }
        const MM_TO_PX = 96 / 25.4;
        const availableWidth = (297 - 16) * MM_TO_PX; // A4 أفقي ناقص الهوامش
        const availableHeight = (210 - 16) * MM_TO_PX;
        const title = page.querySelector(".o_gl_title");
        const contentHeight = () => printable.scrollHeight + (title ? title.offsetHeight : 0);

        page.classList.add("o_gl_print_fit");
        try {
            // 1) أقل عرض يكفي الأرقام = أطول رقم + الحشو الداخلي للخلية
            const valueCells = [...table.querySelectorAll("tbody .o_gl_num, tfoot .o_gl_num")]
                .filter((cell) => cell.textContent.trim());
            if (valueCells.length) {
                const style = getComputedStyle(valueCells[0]);
                const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + 4;
                const widest = Math.max(...valueCells.map((cell) => this._textWidth(cell)));
                page.style.setProperty("--gl-num-w", `${Math.ceil(widest + padding)}px`);
            }
            page.style.setProperty("--gl-ref-w", "130px");

            // 2) نسبة ملء الصفحة (تكبير أو تصغير)، بحد أعلى معقول للتكبير
            let scale = Math.min(
                availableWidth / (printable.scrollWidth || 1),
                availableHeight / (contentHeight() || 1),
                3
            ) * 0.985;

            // 3) ملء الفراغ الرأسي المتبقي بزيادة تباعد الصفوف
            const rows = table.querySelectorAll("tr").length;
            const spare = availableHeight / scale - contentHeight();
            if (rows && spare > 0) {
                page.style.setProperty("--gl-row-pad", `${Math.min(spare / (2 * rows), 10).toFixed(2)}px`);
                scale = Math.min(
                    availableWidth / (printable.scrollWidth || 1),
                    availableHeight / (contentHeight() || 1),
                    3
                ) * 0.985;
            }
            page.style.setProperty("--gl-print-scale", scale.toFixed(4));
            window.print();
        } finally {
            page.classList.remove("o_gl_print_fit");
            page.style.removeProperty("--gl-num-w");
            page.style.removeProperty("--gl-ref-w");
            page.style.removeProperty("--gl-row-pad");
        }
    }

    exportExcel() {
        const { y, m } = this.yearMonth;
        const url = `/my_accounting/general_ledger/xlsx?year=${y}&month=${m}` +
            `&states=${encodeURIComponent(this.state.states.join(","))}`;
        window.location.href = url;
    }

    fmt(v) {
        return v ? v.toFixed(3) : "";
    }
}

registry.category("actions").add("my_accounting.general_ledger", GeneralLedger);
