/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { PeriodFilter } from "./period_filter";
import { usePrintPageSize } from "./print_page_size";
import { openRecord } from "./open_record";

const STATE_FILTERS = [
    { value: "posted", label: "مرحّل" },
    { value: "draft", label: "مسودة" },
    { value: "incomplete", label: "غير مكتمل" },
];

function pad(n) {
    return String(n).padStart(2, "0");
}

export class TrialBalance extends Component {
    static template = "my_accounting.TrialBalance";
    static components = { PeriodFilter };
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.actionService = useService("action");
        const today = new Date();
        this.state = useState({
            data: null,
            loading: true,
            // الفترة: شهر دفتر الأستاذ (افتراضياً الشهر الحالي) أو نطاق تواريخ
            ledgerFrom: `${today.getFullYear()}-${pad(today.getMonth() + 1)}`,
            ledgerTo: `${today.getFullYear()}-${pad(today.getMonth() + 1)}`,
            dateFrom: "",
            dateTo: "",
            states: ["posted"],
            showEmpty: false,
        });
        this.stateFilters = STATE_FILTERS;
        // ميزان المراجعة يبقى عمودياً
        this.printPage = usePrintPageSize("A4 portrait", "10mm");
        onWillStart(async () => {
            // نفس سلوك بقية الشاشات: الافتتاح على آخر شهر فيه قيود
            const latest = await this.orm.call("myaccounting.move", "get_latest_ledger_period", []);
            if (latest && latest.month) {
                const value = `${latest.year}-${pad(parseInt(latest.month, 10))}`;
                this.state.ledgerFrom = value;
                this.state.ledgerTo = value;
            }
            await this.loadData();
        });
    }

    get filterYear() {
        return (this.state.ledgerFrom || this.state.ledgerTo || "").split("-")[0] ||
            String(new Date().getFullYear());
    }

    // شهر واحد مختار (وإلا فالفترة سنة كاملة أو نطاق)
    get filterMonth() {
        const from = this.state.ledgerFrom;
        return from && from === this.state.ledgerTo ? String(parseInt(from.split("-")[1], 10)) : "";
    }

    // فلتر الفترة الموحّد: شهر واحد، أو السنة كاملة عند إلغاء الشهر
    async onPeriodChange({ year, month }) {
        const target = year || this.filterYear;
        this.state.ledgerFrom = `${target}-${month ? pad(parseInt(month, 10)) : "01"}`;
        this.state.ledgerTo = `${target}-${month ? pad(parseInt(month, 10)) : "12"}`;
        this.state.dateFrom = "";
        this.state.dateTo = "";
        await this.loadData();
    }

    async loadData() {
        this.state.loading = true;
        this.state.data = await this.orm.call("myaccounting.account", "get_trial_balance", [], {
            date_from: this.state.dateFrom || false,
            date_to: this.state.dateTo || false,
            ledger_from: this.state.dateFrom || this.state.dateTo ? false : this.state.ledgerFrom || false,
            ledger_to: this.state.dateFrom || this.state.dateTo ? false : this.state.ledgerTo || false,
            states: this.state.states,
            show_empty: this.state.showEmpty,
        });
        this.state.loading = false;
    }

    onFieldChange(field, ev) {
        this.state[field] = ev.target.value;
        this.loadData();
    }

    toggleShowEmpty(ev) {
        this.state.showEmpty = ev.target.checked;
        this.loadData();
    }

    isStateActive(value) {
        return this.state.states.includes(value);
    }

    onStateFilter(value) {
        const states = this.isStateActive(value)
            ? this.state.states.filter((state) => state !== value)
            : [...this.state.states, value];
        this.state.states = states.length ? states : ["posted"];
        this.loadData();
    }

    clearFilters() {
        const today = new Date();
        Object.assign(this.state, {
            ledgerFrom: `${today.getFullYear()}-${pad(today.getMonth() + 1)}`,
            ledgerTo: `${today.getFullYear()}-${pad(today.getMonth() + 1)}`,
            dateFrom: "",
            dateTo: "",
            states: ["posted"],
            showEmpty: false,
        });
        this.loadData();
    }

    fmt(value) {
        // نتجنّب إظهار "-0.000" الناتج عن تقريب الأصفار
        return Math.abs(value || 0) < 0.0005 ? "" : value.toFixed(3);
    }

    openAccount(id, isMiddleClick = false) {
        openRecord(this.actionService, "myaccounting.account", id, isMiddleClick);
    }

    // الطباعة في صفحة A4 عمودية واحدة، مع تصغير محسوب إن طال الجدول
    printReport() {
        const page = document.querySelector(".o_trial_balance");
        const printable = page && page.querySelector(".o_tb_printable");
        if (printable) {
            const MM_TO_PX = 96 / 25.4;
            const availableHeight = (297 - 20) * MM_TO_PX;
            const availableWidth = (210 - 20) * MM_TO_PX;
            let zoom = Math.min(availableWidth / (printable.scrollWidth || 1), 1);
            page.style.setProperty("--tb-print-scale", zoom.toFixed(4));
            const height = printable.scrollHeight * zoom;
            if (height > availableHeight) {
                zoom = zoom * (availableHeight / height) * 0.99;
                page.style.setProperty("--tb-print-scale", zoom.toFixed(4));
            }
        }
        window.print();
    }

    exportExcel() {
        const params = new URLSearchParams({
            date_from: this.state.dateFrom || "",
            date_to: this.state.dateTo || "",
            ledger_from: this.state.dateFrom || this.state.dateTo ? "" : this.state.ledgerFrom || "",
            ledger_to: this.state.dateFrom || this.state.dateTo ? "" : this.state.ledgerTo || "",
            states: this.state.states.join(","),
            show_empty: this.state.showEmpty ? "1" : "",
        });
        window.location.href = `/my_accounting/trial_balance/xlsx?${params.toString()}`;
    }
}

registry.category("actions").add("my_accounting.trial_balance", TrialBalance);
