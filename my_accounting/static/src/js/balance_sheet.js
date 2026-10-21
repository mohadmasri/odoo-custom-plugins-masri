/** @odoo-module **/

import { Component, onWillStart, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { openRecord } from "./open_record";
import { usePrintPageSize } from "./print_page_size";

/**
 * الميزانية السنوية: الأصول في جانب، والخصوم وحقوق الملكية ونتيجة السنة
 * في الجانب الآخر، من أرصدة الحسابات حتى نهاية السنة المختارة.
 *
 * تصنيف الحسابات الرئيسية يبدأ من رمزها ويبقى للمستخدم تصحيحه، لأن رمزاً
 * واحداً قد يجمع حسابات ليست من بابه.
 */
export class BalanceSheet extends Component {
    static template = "my_accounting.BalanceSheet";
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.actionService = useService("action");
        this.notification = useService("notification");
        this.printPage = usePrintPageSize("A4 portrait", "8mm");
        this.state = useState({
            loading: true,
            data: null,
            year: "",
            showGroups: false,
            groups: null,
            showEmpty: false,
            busy: false,
        });
        onWillStart(async () => {
            await this.load();
            this.state.groups = await this.orm.call(
                "myaccounting.account", "get_statement_groups", []);
        });
    }

    async load() {
        this.state.loading = true;
        try {
            const data = await this.orm.call("myaccounting.account", "get_balance_sheet",
                [this.state.year || false, ["posted"], this.state.showEmpty]);
            this.state.data = data;
            this.state.year = `${data.year}`;
        } finally {
            this.state.loading = false;
        }
    }

    get data() {
        return this.state.data;
    }

    /** جانب من جوانب الميزانية بمفتاحه */
    section(key) {
        const sections = this.state.data ? this.state.data.sections : [];
        return sections.find((item) => item.key === key) || { roots: [], total: 0 };
    }

    isYear(year) {
        return `${year}` === this.state.year;
    }

    async onYear(ev) {
        this.state.year = ev.target.value;
        await this.load();
    }

    async toggleEmpty() {
        this.state.showEmpty = !this.state.showEmpty;
        await this.load();
    }

    toggleGroups() {
        this.state.showGroups = !this.state.showGroups;
    }

    async onGroup(root, ev) {
        this.state.busy = true;
        try {
            this.state.groups = await this.orm.call(
                "myaccounting.account", "set_statement_group", [root.id, ev.target.value]);
            await this.load();
        } catch (error) {
            this.notification.add(error.data?.message || "تعذّر حفظ التصنيف.",
                { type: "danger" });
        } finally {
            this.state.busy = false;
        }
    }

    isGroup(root, key) {
        return root.group === key;
    }

    openAccount(accountId, isMiddleClick) {
        openRecord(this.actionService, "myaccounting.account", accountId, isMiddleClick);
    }

    fmt(value) {
        let number = Number(value) || 0;
        if (Math.abs(number) < 0.0005) {
            number = 0;
        }
        return number.toLocaleString("en-US", {
            minimumFractionDigits: 3, maximumFractionDigits: 3,
        });
    }

    print() {
        this.printPage.enable();
        window.print();
    }
}

registry.category("actions").add("my_accounting.balance_sheet", BalanceSheet);
