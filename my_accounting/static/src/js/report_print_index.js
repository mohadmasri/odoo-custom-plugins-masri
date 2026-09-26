/* خيار "مع فهرس" قبل أي طباعة تمرّ عبر تقارير النظام (قيود، سندات، كشوف حسابات).
   ملف عادي (بلا وحدات) لأنه يُحمَّل داخل صفحة التقرير نفسها. */
(function () {
    "use strict";

    var PAGE_HEIGHT_MM = { portrait: 297 - 16, landscape: 210 - 16 };
    var MM_TO_PX = 96 / 25.4;
    var STORAGE_KEY = "my_accounting_print_index";

    function lastChoice() {
        try {
            return localStorage.getItem(STORAGE_KEY) === "1";
        } catch (error) {
            return false;
        }
    }

    function rememberChoice(withIndex) {
        try {
            localStorage.setItem(STORAGE_KEY, withIndex ? "1" : "0");
        } catch (error) {
            // التخزين المحلي معطّل: الاختيار يبقى لهذه الطباعة فقط
        }
    }

    /** ارتفاع صفحة الطباعة بالبكسل حسب اتجاهها */
    function pageHeight(config) {
        var mm = PAGE_HEIGHT_MM[config.orientation === "landscape" ? "landscape" : "portrait"];
        return mm * MM_TO_PX;
    }

    /** كم صفحة يشغل هذا العنصر */
    function pagesOf(el, height) {
        return Math.max(1, Math.ceil(el.getBoundingClientRect().height / height - 0.02));
    }

    function buildIndex(config, docs) {
        var height = pageHeight(config);
        var index = document.createElement("div");
        index.className = "o_ma_index_page";

        var title = document.createElement("h2");
        title.className = "o_ma_index_title";
        title.textContent = config.title || "الفهرس";
        index.appendChild(title);

        var table = document.createElement("table");
        table.className = "table table-bordered o_ma_index_table";
        var headers = (config.headers || "").split("|");
        table.innerHTML =
            "<thead><tr>" +
            headers.map(function (text) {
                return "<th>" + text + "</th>";
            }).join("") +
            "<th class='o_ma_index_page_col'>الصفحة</th></tr></thead><tbody></tbody>";
        index.appendChild(table);
        document.body.insertBefore(index, document.body.firstChild);

        // صفحات الفهرس نفسه تأتي أولاً، ثم المستندات بالترتيب
        var body = table.querySelector("tbody");
        var page = 1;
        var rows = [];
        docs.forEach(function (doc) {
            var cells = (doc.getAttribute("data-ma-info") || "").split("|");
            var row = document.createElement("tr");
            row.innerHTML =
                cells.map(function (text) {
                    return "<td>" + text + "</td>";
                }).join("") + "<td class='o_ma_index_page_col'></td>";
            body.appendChild(row);
            rows.push({ row: row, doc: doc });
        });

        // بعد رسم الفهرس نعرف كم صفحة يشغل، فنبدأ الترقيم بعده
        page = 1 + pagesOf(index, height);
        rows.forEach(function (item) {
            item.row.lastElementChild.textContent = page;
            stampPage(item.doc, page);
            page += pagesOf(item.doc, height);
        });
    }

    /** رقم الصفحة على المستند نفسه، ليطابق ما في الفهرس */
    function stampPage(doc, page) {
        var stamp = document.createElement("div");
        stamp.className = "o_ma_page_stamp";
        stamp.textContent = "صفحة " + page;
        doc.insertBefore(stamp, doc.firstChild);
    }

    function print(config, withIndex) {
        rememberChoice(withIndex);
        var bar = document.querySelector(".o_ma_print_bar");
        if (bar) {
            bar.remove();
        }
        if (withIndex) {
            var docs = [].slice.call(document.querySelectorAll("[data-ma-doc]"));
            if (docs.length) {
                buildIndex(config, docs);
            }
        }
        window.print();
    }

    function askAndPrint(config) {
        var bar = document.createElement("div");
        bar.className = "o_ma_print_bar";
        bar.innerHTML =
            "<span class='o_ma_print_question'>هل تريد صفحة فهرس في أول الطباعة؟</span>" +
            "<button type='button' class='btn btn-primary btn-sm o_ma_with'>طباعة مع فهرس</button>" +
            "<button type='button' class='btn btn-secondary btn-sm o_ma_without'>طباعة بلا فهرس</button>";
        document.body.insertBefore(bar, document.body.firstChild);
        bar.querySelector(".o_ma_with").addEventListener("click", function () {
            print(config, true);
        });
        bar.querySelector(".o_ma_without").addEventListener("click", function () {
            print(config, false);
        });
        // الاختيار السابق يصبح الزر المركّز، فتكفي مسافة أو Enter
        bar.querySelector(lastChoice() ? ".o_ma_with" : ".o_ma_without").focus();
    }

    window.addEventListener("load", function () {
        var holder = document.querySelector("[data-ma-print]");
        if (!holder) {
            return;
        }
        var config = {
            title: holder.getAttribute("data-ma-title"),
            headers: holder.getAttribute("data-ma-headers"),
            orientation: holder.getAttribute("data-ma-orientation"),
        };
        // ننتظر انتهاء ضبط المقاس في التقرير (إن وُجد) قبل عرض السؤال
        setTimeout(function () {
            askAndPrint(config);
        }, 0);
    });
})();
