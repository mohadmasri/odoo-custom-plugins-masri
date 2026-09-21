/** @odoo-module **/

import { Component, onWillStart, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { HomeReports } from "./reports";

export class MyAccountingHome extends Component {
    static template = "my_accounting.Home";
    static props = ["*"];
    static components = { HomeReports };

    setup() {
        this.actionService = useService("action");
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.state = useState({ todos: [], todosAllowed: true, newTodo: "", stats: null });

        this.navCards = {
            newMove: {
                title: "قيد جديد",
                desc: "إنشاء قيد محاسبي جديد مباشرة",
                icon: "fa-plus-circle",
                color: "#00A09D",
                action: () => this.actionService.doAction("my_accounting.action_myaccounting_move_new_form"),
            },
            moves: {
                title: "القيود",
                desc: "استعراض والبحث في القيود المحاسبية",
                icon: "fa-list-alt",
                color: "#714B67",
                action: () => this.actionService.doAction("my_accounting.action_myaccounting_move_list"),
            },
            accounts: {
                title: "شجرة الحسابات",
                desc: "إدارة الحسابات وهيكلها الهرمي",
                icon: "fa-sitemap",
                color: "#017E84",
                action: () => this.actionService.doAction("my_accounting.action_myaccounting_account_tree"),
            },
            ledger: {
                title: "دفتر الأستاذ العام",
                desc: "تقرير شهري بحركات كل حساب",
                icon: "fa-book",
                color: "#F06050",
                action: () => this.actionService.doAction("my_accounting.action_myaccounting_general_ledger"),
            },
        };

        // مربعات المؤشرات السفلية (من اليمين): أرقام صفحة العملاء، والضغط يفتح التبويب المناسب
        this.statBoxes = [
            {
                key: "stat_1", title: "إجمالي الفواتير", icon: "fa-file-text-o", color: "#E67E22",
                value: (s) => this.fmt(s.invoiced),
                hint: () => "صافي بعد المرتجعات",
                context: {},
            },
            {
                key: "stat_2", title: "المحصّل (سندات القبض)", icon: "fa-money", color: "#28A745",
                value: (s) => this.fmt(s.collected),
                hint: (s) => `${s.receipt_count} سند قبض`,
                context: { customers_tab: "receipts" },
            },
            {
                key: "stat_3", title: "المستحق على العملاء", icon: "fa-users", color: "#DC3545",
                value: (s) => this.fmt(s.balance),
                hint: (s) => `على ${s.customer_count} عملاء`,
                context: { customers_tab: "invoices" },
            },
            {
                key: "stat_4", title: "فواتير غير محصّلة", icon: "fa-exclamation-circle", color: "#17A2B8",
                value: (s) => String(s.open_count),
                hint: (s) => `متبقٍّ عليها ${this.fmt(s.remaining)}`,
                context: { customers_tab: "invoices", invoice_status: "open" },
            },
        ];

        onWillStart(() => Promise.all([this.loadTodos(), this.loadStats()]));
    }

    // ------------------------------------------------------------------
    // مربعات المؤشرات
    // ------------------------------------------------------------------

    async loadStats() {
        try {
            this.state.stats = await this.orm.call("myaccounting.customers", "get_home_stats", []);
        } catch {
            this.state.stats = null; // بلا صلاحية على الحسابات: تبقى المربعات بلا أرقام
        }
    }

    fmt(value) {
        return (Math.abs(value || 0) < 0.0005 ? 0 : value)
            .toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
    }

    openStat(box) {
        this.actionService.doAction("my_accounting.action_myaccounting_customers", {
            additionalContext: box.context,
        });
    }

    // ------------------------------------------------------------------
    // قائمة التذكير (نفس مهام تطبيق To-do في أودو)
    // ------------------------------------------------------------------

    applyTodos(result) {
        this.state.todosAllowed = result.allowed;
        this.state.todos = result.items;
    }

    async loadTodos() {
        this.applyTodos(await this.orm.call("myaccounting.move", "get_home_todos", []));
    }

    async addTodo() {
        const name = this.state.newTodo.trim();
        if (!name) {
            return;
        }
        this.applyTodos(await this.orm.call("myaccounting.move", "add_home_todo", [name]));
        this.state.newTodo = "";
    }

    onTodoKeydown(ev) {
        if (ev.key === "Enter") {
            this.addTodo();
        }
    }

    async completeTodo(todo) {
        this.applyTodos(await this.orm.call("myaccounting.move", "done_home_todo", [todo.id]));
        this.notification.add(`تم إنجاز: ${todo.name}`, { type: "success" });
    }

    openTodoApp() {
        this.actionService.doAction("project_todo.project_task_action_todo");
    }
}

registry.category("actions").add("my_accounting.home", MyAccountingHome);
