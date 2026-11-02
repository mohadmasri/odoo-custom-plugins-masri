/** @odoo-module **/

/**
 * حاسبة صيغ الكتل الجاهزة: حساب بسيط على خانات المبالغ، مثل
 * "amount + commission" أو "amount - amount / (1 + rate / 100)".
 *
 * مكتوبة بمحلّل صغير لا بـ eval: الصيغة يكتبها المستخدم في الإعدادات،
 * فلا يجوز أن تُنفَّذ كشيفرة.
 */

const NUMBER_RE = /^\d+(\.\d+)?/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

function tokenize(text) {
    const tokens = [];
    let rest = String(text || "").trim();
    while (rest.length) {
        const char = rest[0];
        if (char === " " || char === "\t") {
            rest = rest.slice(1);
            continue;
        }
        if ("+-*/()".includes(char)) {
            tokens.push({ type: char });
            rest = rest.slice(1);
            continue;
        }
        const number = NUMBER_RE.exec(rest);
        if (number) {
            tokens.push({ type: "num", value: parseFloat(number[0]) });
            rest = rest.slice(number[0].length);
            continue;
        }
        const name = NAME_RE.exec(rest);
        if (name) {
            tokens.push({ type: "name", value: name[0] });
            rest = rest.slice(name[0].length);
            continue;
        }
        throw new Error(`رمز غير مفهوم: ${char}`);
    }
    return tokens;
}

/** تحليل تنازلي بسيط: جمع/طرح ← ضرب/قسمة ← قوس أو رقم أو اسم خانة */
function parse(tokens, values) {
    let at = 0;
    const peek = () => tokens[at];
    const take = (type) => {
        if (!tokens[at] || tokens[at].type !== type) {
            throw new Error("صيغة غير مكتملة");
        }
        return tokens[at++];
    };

    function primary() {
        const token = peek();
        if (!token) {
            throw new Error("صيغة غير مكتملة");
        }
        if (token.type === "-") {
            at++;
            return -primary();
        }
        if (token.type === "+") {
            at++;
            return primary();
        }
        if (token.type === "(") {
            at++;
            const value = expression();
            take(")");
            return value;
        }
        if (token.type === "num") {
            at++;
            return token.value;
        }
        if (token.type === "name") {
            at++;
            if (!(token.value in values)) {
                throw new Error(`لا توجد خانة اسمها ${token.value}`);
            }
            return Number(values[token.value]) || 0;
        }
        throw new Error("صيغة غير مفهومة");
    }

    function term() {
        let value = primary();
        while (peek() && (peek().type === "*" || peek().type === "/")) {
            const operator = tokens[at++].type;
            const right = primary();
            if (operator === "/") {
                value = right === 0 ? 0 : value / right;   // القسمة على صفر تعطي صفراً
            } else {
                value *= right;
            }
        }
        return value;
    }

    function expression() {
        let value = term();
        while (peek() && (peek().type === "+" || peek().type === "-")) {
            const operator = tokens[at++].type;
            value = operator === "+" ? value + term() : value - term();
        }
        return value;
    }

    const result = expression();
    if (at !== tokens.length) {
        throw new Error("زيادة في الصيغة بعد نهايتها");
    }
    return result;
}

/** يحسب الصيغة، ويعيد {value} أو {error} ليُعرض للمستخدم كما هو */
export function evalFormula(formula, values) {
    try {
        const result = parse(tokenize(formula), values || {});
        if (!isFinite(result)) {
            return { value: 0, error: "نتيجة غير صالحة" };
        }
        return { value: Math.round(result * 1000) / 1000 };
    } catch (error) {
        return { value: 0, error: error.message };
    }
}

/** أسماء الخانات المذكورة في صيغة، للتحقق منها في صفحة الإعدادات */
export function formulaNames(formula) {
    try {
        return tokenize(formula).filter((t) => t.type === "name").map((t) => t.value);
    } catch {
        return [];
    }
}

/**
 * بنود فاتورةٍ بعينها من بنودٍ معروضة.
 *
 * البيان يُكتب على اختلافه: «فاتورة 316 وزارة الاشغال» و«فاتورة رقم 325
 * وزارة الاشغال» و«فاتورة رقم 332 / وزارة الاشغال». ويبدأ بالفاتورة فلا
 * يُطابق «مرتجع فاتورة رقم …»، والرقم لا يُتبع برقمٍ آخر فـ316 ليست 3160.
 * وهي صورة _invoice_pattern في الخادم.
 */
export function invoiceLines(lines, number) {
    const text = String(number || "").trim();
    if (!text) {
        return [];
    }
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^\\s*فاتورة\\s*(?:رقم\\s*)?${escaped}(?!\\d)`);
    return (lines || []).filter((line) => pattern.test(String(line.name || "")));
}

/**
 * فاتورةٌ مقروءة من بنودها: إجماليها ونسبتها وحساب جهتها.
 *
 * الجهة هي البند المدين (الذمم)، والإيراد أكبر الدائنين والضريبة ما بقي،
 * فتُستخرج النسبة منهما. وهي صورة ما يفعله الخادم بالقيود المحفوظة.
 */
export function readInvoice(lines) {
    const own = lines || [];
    const debit = own.find((line) => (line.debit || 0) > 0);
    if (!debit) {
        return false;
    }
    const credits = own.filter((line) => (line.credit || 0) > 0)
        .sort((first, second) => second.credit - first.credit);
    const round = (value) => Math.round(value * 1000) / 1000;
    const total = round(debit.debit);
    const revenue = credits.length ? round(credits[0].credit) : 0;
    const tax = credits.length > 1 ? round(credits[1].credit) : round(total - revenue);
    return {
        total,
        rate: revenue ? round((tax / revenue) * 100) : 0,
        account_id: debit.account_id || false,
    };
}

/**
 * بيان الكتلة من صيغتها: «فاتورة رقم {invoice} / {account}».
 *
 * {مفتاح الخانة} يأخذ ما كُتب فيها، و{account} يأخذ اسم الحساب المختار
 * في أول بندٍ يُسأل عن حسابه. ويُرجع ما نقص ليُطلب من المستخدم.
 */
export function buildBlockText(block, values, chosenAccounts, accounts) {
    const template = block.text_template || "";
    if (!template) {
        return { text: "", missing: [] };
    }
    const missing = [];
    const asked = block.lines.find((line) => line.ask_account);
    const text = template.replace(/\{([^{}]+)\}/g, (whole, key) => {
        const name = key.trim();
        if (name === "account") {
            const chosen = asked ? chosenAccounts[asked.id] : false;
            const account = (accounts || []).find((item) => item.id === chosen);
            if (!account) {
                missing.push(asked ? (asked.account_prompt || "الحساب") : "الحساب");
                return "";
            }
            return account.name;
        }
        const field = block.fields.find((item) => item.key === name);
        const value = String(values[name] === undefined ? "" : values[name]).trim();
        if (!value) {
            missing.push(field ? field.label : name);
            return "";
        }
        return value;
    });
    return { text: text.replace(/\s+/g, " ").trim(), missing };
}

/**
 * بنود الكتلة كما ستُضاف: يحسب كل بند من صيغته ويطرح الفارغ منها.
 * values: قيم خانات المبالغ، accounts: الحساب المختار لكل بند يُسأل عنه.
 */
export function buildBlockLines(block, values, chosenAccounts, mainText) {
    const lines = [];
    for (const line of block.lines) {
        const computed = evalFormula(line.formula, values);
        const amount = computed.value;
        const accountId = line.ask_account
            ? chosenAccounts[line.id] || false
            : line.account_id;
        if (!amount && !line.zero_visible) {
            continue;   // بند بلا مبلغ ولا يُراد إظهاره بصفر
        }
        lines.push({
            key: line.id,
            name: line.label || mainText,
            account_id: accountId,
            debit: line.side === "debit" ? amount : 0,
            credit: line.side === "credit" ? amount : 0,
            debit_zero_entered: line.side === "debit" && !amount,
            credit_zero_entered: line.side === "credit" && !amount,
            error: computed.error || "",
        });
    }
    return lines;
}
