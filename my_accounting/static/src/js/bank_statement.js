/** @odoo-module **/

import { Component, onWillStart, useState } from "@odoo/owl";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { openRecord } from "./open_record";

/**
 * كشف البنك: يُرفع ملف الكشف فيُقرأ ويُطابَق مع قيود حساب البنك،
 * ثم يُعرض ما طابق وما لم يطابق والفرق بين رصيد البنك ورصيد الدفاتر.
 */
export class BankStatementPage extends Component {
    static template = "my_accounting.BankStatement";
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.actionService = useService("action");
        this.dialog = useService("dialog");
        this.notification = useService("notification");
        this.state = useState({
            loading: true,
            busy: false,
            accounts: [],
            accountId: false,
            statements: [],
            data: null,
            view: "unmatched",   // all أو unmatched أو book
        });
        onWillStart(async () => {
            const banks = await this.orm.call(
                "myaccounting.bank.statement", "get_bank_accounts", []);
            this.state.accounts = banks.accounts;
            this.state.accountId = banks.default_id;
            await this.refresh();
            this.state.loading = false;
        });
    }

    async refresh(statementId) {
        const [statements, data] = await Promise.all([
            this.orm.call("myaccounting.bank.statement", "get_statements", []),
            this.orm.call("myaccounting.bank.statement", "get_statement",
                [statementId || false]),
        ]);
        this.state.statements = statements;
        this.state.data = data || null;
        if (data) {
            this.state.accountId = data.account_id;
        }
    }

    get data() {
        return this.state.data;
    }

    onAccount(ev) {
        this.state.accountId = parseInt(ev.target.value, 10) || false;
    }

    setView(view) {
        this.state.view = view;
    }

    isStatement(id) {
        return this.state.data && this.state.data.id === id;
    }

    async openStatement(ev) {
        const id = parseInt(ev.target.value, 10);
        if (id) {
            await this.refresh(id);
        }
    }

    /** يقرأ الملف إلى base64 ثم يرسله للخادم ليحلّله */
    async onFile(ev) {
        const file = ev.target.files && ev.target.files[0];
        if (!file) {
            return;
        }
        if (!this.state.accountId) {
            this.notification.add("اختر حساب البنك أولاً.", { type: "warning" });
            return;
        }
        this.state.busy = true;
        try {
            const content = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(`${reader.result}`.split(",")[1]);
                reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(file);
            });
            const id = await this.orm.call("myaccounting.bank.statement", "import_file",
                [this.state.accountId, file.name, content]);
            await this.refresh(id);
            this.notification.add("قُرئ الكشف.", { type: "success" });
        } catch (error) {
            this.notification.add(error.data?.message || "تعذّرت قراءة الملف.",
                { type: "danger" });
        } finally {
            this.state.busy = false;
            ev.target.value = "";
        }
    }

    async rematch() {
        this.state.busy = true;
        try {
            await this.orm.call("myaccounting.bank.statement", "match",
                [[this.state.data.id]]);
            await this.refresh(this.state.data.id);
        } finally {
            this.state.busy = false;
        }
    }

    deleteStatement() {
        const statement = this.state.data;
        this.dialog.add(ConfirmationDialog, {
            title: `حذف "${statement.name}"`,
            body: "سيُحذف الكشف المقروء. لا يمسّ هذا قيودك.",
            confirmLabel: "احذف",
            confirm: async () => {
                await this.orm.call("myaccounting.bank.statement", "delete_statement",
                    [[statement.id]]);
                await this.refresh();
            },
            cancel: () => {},
        });
    }

    openMove(moveId, isMiddleClick) {
        if (moveId) {
            openRecord(this.actionService, "myaccounting.move", moveId, isMiddleClick);
        }
    }

    /** الفرق بين رصيد البنك ورصيد الدفاتر، وما يفسّره */
    get gap() {
        const data = this.state.data;
        if (!data) {
            return { difference: 0, explained: 0, rest: 0 };
        }
        const difference = this.round(data.closing_balance - data.book_balance);
        const explained = this.round(data.unmatched_total - data.book_only_total);
        return { difference, explained, rest: this.round(difference - explained) };
    }

    round(value) {
        return Math.round((Number(value) || 0) * 1000) / 1000;
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
}

registry.category("actions").add("my_accounting.bank_statement", BankStatementPage);
