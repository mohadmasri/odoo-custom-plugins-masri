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
