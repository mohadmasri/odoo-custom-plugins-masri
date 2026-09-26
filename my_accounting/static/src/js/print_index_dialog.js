/** @odoo-module **/

import { Component } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";

const STORAGE_KEY = "my_accounting_print_index";

/** آخر اختيار للمستخدم: يُستخدم لتمييز الزر المقترح فقط، والسؤال يبقى في كل طباعة */
export function lastIndexChoice() {
    try {
        return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
        return false;
    }
}

function remember(withIndex) {
    try {
        localStorage.setItem(STORAGE_KEY, withIndex ? "1" : "0");
    } catch {
        // التخزين المحلي معطّل: الاختيار لهذه الطباعة فقط
    }
}

/** سؤال "مع فهرس؟" قبل الطباعة من شاشات النظام */
export class PrintIndexDialog extends Component {
    static template = "my_accounting.PrintIndexDialog";
    static components = { Dialog };
    static props = ["onChoice", "close"];

    get suggested() {
        return lastIndexChoice();
    }

    choose(withIndex) {
        remember(withIndex);
        this.props.close();
        this.props.onChoice(withIndex);
    }
}

/**
 * يعرض السؤال ثم ينفّذ الطباعة.
 * @param {object} dialogService خدمة النوافذ
 * @param {(withIndex: boolean) => void} print دالة الطباعة الفعلية
 */
export function askPrintIndex(dialogService, print) {
    dialogService.add(PrintIndexDialog, { onChoice: print });
}

/**
 * يبني صفحة فهرس في أول الطباعة لشاشة فيها مستند واحد (دفتر الأستاذ، ميزان
 * المراجعة): سطر واحد بعنوان التقرير وفترته ورقم صفحته، مع ختم رقم الصفحة.
 * يعيد دالة لإزالة ما أُضيف بعد انتهاء الطباعة.
 */
export function addSinglePageIndex(container, { title, rows, headers, scale = 1 }) {
    const index = document.createElement("div");
    index.className = "o_ma_index_page";
    index.style.zoom = (1 / (scale || 1)).toFixed(4);
    index.innerHTML =
        `<h2 class="o_ma_index_title">${title}</h2>` +
        '<table class="table table-bordered o_ma_index_table"><thead><tr>' +
        headers.map((text) => `<th>${text}</th>`).join("") +
        '<th class="o_ma_index_page_col">الصفحة</th></tr></thead><tbody>' +
        rows.map((cells) =>
            "<tr>" + cells.map((text) => `<td>${text}</td>`).join("") +
            '<td class="o_ma_index_page_col">2</td></tr>').join("") +
        "</tbody></table>";

    const stamp = document.createElement("div");
    stamp.className = "o_ma_page_stamp";
    stamp.textContent = "صفحة 2";

    container.insertBefore(index, container.firstChild);
    index.after(stamp);
    return () => {
        index.remove();
        stamp.remove();
    };
}
