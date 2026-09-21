/** @odoo-module **/

import { Component, onWillStart, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

export class MyAccountingHome extends Component {
    static template = "my_accounting.Home";
    static props = ["*"];

    setup() {
        this.actionService = useService("action");
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.state = useState({ todos: [], todosAllowed: true, newTodo: "" });

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

        // مربعات المؤشرات السفلية: تصميم فقط حالياً، وتُربط بالبيانات في خطوة لاحقة
        this.statBoxes = [
            { key: "claims_1", title: "المطالبات", icon: "fa-file-text-o", color: "#E67E22" },
            { key: "receipts", title: "سندات القبض", icon: "fa-money", color: "#17A2B8" },
            { key: "collected", title: "الذمم المحصلة", icon: "fa-check-circle", color: "#28A745" },
            { key: "claims_2", title: "المطالبات", icon: "fa-file-text-o", color: "#E67E22" },
        ];

        onWillStart(() => this.loadTodos());
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
