/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

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
        });
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
            [y, m]
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

    openMove(id) {
        this.actionService.doAction({
            type: "ir.actions.act_window",
            res_model: "myaccounting.move",
            res_id: id,
            views: [[false, "form"]],
            target: "current",
        });
    }

    printLedger() {
        window.print();
    }

    exportExcel() {
        const { y, m } = this.yearMonth;
        const url = `/my_accounting/general_ledger/xlsx?year=${y}&month=${m}`;
        window.location.href = url;
    }

    fmt(v) {
        return v ? v.toFixed(3) : "";
    }
}

registry.category("actions").add("my_accounting.general_ledger", GeneralLedger);
