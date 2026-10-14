"""البحث العام: شريط واحد يبحث في كل شيء بنصّ واحد.

يُقسَّم النص إلى كلمات ويُطلب أن تَرِد كلها، بأي ترتيب وبينها ما بينها،
فـ"كفالة 85" يجد "كفالة رقم 85/26 دخول عطاء وزارة الزراعة". ويتسامح مع
صور الحروف (كفالة/كفاله) وشكل الأرقام (290/٢٩٠)، ويفهم الرقم رقمَ قيد
ورمزَ حساب ومبلغاً معاً.
"""
import re

from odoo import api, fields, models

ARABIC_TO_LATIN = str.maketrans('٠١٢٣٤٥٦٧٨٩', '0123456789')
LATIN_TO_ARABIC = str.maketrans('0123456789', '٠١٢٣٤٥٦٧٨٩')
AMOUNT_RE = re.compile(r'^\d+(\.\d+)?$')
# حروف تُكتب بصور متعددة: نضع مكانها محرف "أي حرف واحد" في نمط البحث
VARIANTS = 'اأإآٱةهىيئؤو'
TOKEN_SPLIT_RE = re.compile(r'\s+')


def to_latin(text):
    return (text or '').translate(ARABIC_TO_LATIN)


def _fuzzy(token):
    """نمط ILIKE متسامح: كل حرف متعدد الصور يصير "أي حرف واحد"."""
    out = []
    for char in token:
        if char in VARIANTS:
            out.append('_')
        elif char in '%_\\':
            out.append('\\' + char)
        else:
            out.append(char)
    return '%' + ''.join(out) + '%'


def token_patterns(token):
    """صيغ البحث عن كلمة واحدة: كما كُتبت، وبالأرقام العربية، وبالإنجليزية."""
    forms = {token, token.translate(ARABIC_TO_LATIN), token.translate(LATIN_TO_ARABIC)}
    return [_fuzzy(form) for form in forms if form]


def split_tokens(query):
    return [part for part in TOKEN_SPLIT_RE.split((query or '').strip()) if part]


def tokens_domain(tokens, fields_names):
    """كل كلمة يجب أن ترد في أحد الحقول؛ والكلمات مجتمعة بـ"و"."""
    domain = []
    for token in tokens:
        leaves = [(name, 'ilike', pattern)
                  for pattern in token_patterns(token)
                  for name in fields_names]
        if not leaves:
            continue
        domain += ['|'] * (len(leaves) - 1) + leaves
    return domain


class MyAccountingSearch(models.AbstractModel):
    _name = 'myaccounting.search'
    _description = 'البحث العام'

    @api.model
    def _rank(self, tokens, *values):
        """0 مطابقة تامة لكلمة، 1 بداية كلمة، 2 ورودها داخل النص."""
        best = 3
        for value in values:
            text = to_latin(value or '').casefold()
            if not text:
                continue
            for token in tokens:
                needle = to_latin(token).casefold()
                if text == needle:
                    return 0
                if text.startswith(needle):
                    best = min(best, 1)
                elif needle in text:
                    best = min(best, 2)
        return best

    # ------------------------------------------------------------------

    @api.model
    def _move_items(self, tokens, limit):
        Move = self.env['myaccounting.move']
        domain = tokens_domain(tokens, ['name', 'ref', 'journal'])
        moves = Move.search(domain, limit=limit * 4, order='sort_key desc')
        items = []
        for move in moves:
            receipt = move.move_type == 'receipt'
            items.append({
                'kind': 'receipt' if receipt else 'move',
                'kind_label': 'سند قبض' if receipt else 'قيد',
                'icon': 'fa-money' if receipt else 'fa-file-text-o',
                'model': 'myaccounting.move',
                'id': move.id,
                'title': move.name or '—',
                'subtitle': move.ref or '',
                'extra': f'{move.ledger_period_label or ""} · {move.journal or ""}'.strip(' ·'),
                'amount': move.total_debit,
                'rank': self._rank(tokens, move.name, move.ref, move.journal),
            })
        return items

    @api.model
    def _account_items(self, tokens, limit):
        Account = self.env['myaccounting.account']
        accounts = Account.search(tokens_domain(tokens, ['code', 'name']),
                                  limit=limit * 4, order='code_path')
        return [{
            'kind': 'account',
            'kind_label': 'حساب',
            'icon': 'fa-sitemap',
            'model': 'myaccounting.account',
            'id': account.id,
            'title': f'{account.code} - {account.name}' if account.code else account.name,
            'subtitle': account.parent_id.name or '',
            'extra': '',
            'amount': 0.0,
            'rank': self._rank(tokens, account.code, account.name),
        } for account in accounts]

    @api.model
    def _line_items(self, tokens, limit, query):
        """بنود القيود: يُفتح قيدها، فالبند وحده لا معنى له."""
        Line = self.env['myaccounting.move.line']
        domain = tokens_domain(tokens, ['name'])
        amount = to_latin(query).strip()
        if AMOUNT_RE.match(amount):
            # رقم مجرّد: نبحث عنه مبلغاً أيضاً، لا نصّاً فقط
            value = float(amount)
            domain = ['|', '|', ('debit', '=', value), ('credit', '=', value)] + domain
        lines = Line.search(domain, limit=limit * 5, order='move_sort_key desc, id desc')
        items = []
        seen = set()
        for line in lines:
            key = (line.move_id.id, (line.name or '').strip())
            if key in seen:
                continue
            seen.add(key)
            items.append({
                'kind': 'line',
                'kind_label': 'بند',
                'icon': 'fa-list',
                'model': 'myaccounting.move',
                'id': line.move_id.id,
                'title': line.name or '—',
                'subtitle': f'{line.move_id.name or ""} · {line.account_id.name or ""}'.strip(' ·'),
                'extra': fields.Date.to_string(line.date) if line.date else '',
                'amount': line.debit or line.credit,
                'rank': self._rank(tokens, line.name),
            })
        return items

    # ------------------------------------------------------------------

    @api.model
    def search_all(self, query, limit=6):
        """نتائج مجمّعة حسب النوع، لكل نوع أهمّ نتائجه."""
        query = (query or '').strip()
        tokens = split_tokens(query)
        if not tokens or len(query) < 2:
            return {'query': query, 'groups': [], 'total': 0}
        limit = max(1, int(limit))
        groups = []
        total = 0
        for label, items in (
            ('القيود والسندات', self._move_items(tokens, limit)),
            ('الحسابات', self._account_items(tokens, limit)),
            ('بنود القيود', self._line_items(tokens, limit, query)),
        ):
            items.sort(key=lambda item: (item['rank'], item['title']))
            total += len(items)
            if items:
                groups.append({'label': label, 'items': items[:limit],
                               'more': max(0, len(items) - limit)})
        return {'query': query, 'groups': groups, 'total': total}
