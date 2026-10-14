"""البحث العام: شريط واحد يبحث في كل شيء بنصّ واحد.

يبحث في القيود وسندات القبض والحسابات وبنود القيود، ويفهم الرقم: يبحث
عنه رقمَ قيد ورمزَ حساب ومبلغاً في البنود معاً. النتائج مرتّبة بالأهمية:
المطابقة التامة أولاً، ثم ما يبدأ بالنص، ثم ما يحتويه.
"""
import re

from odoo import api, fields, models

ARABIC_DIGITS = str.maketrans('٠١٢٣٤٥٦٧٨٩', '0123456789')
AMOUNT_RE = re.compile(r'^\d+(\.\d+)?$')


def _normalize(text):
    return (text or '').translate(ARABIC_DIGITS).strip()


class MyAccountingSearch(models.AbstractModel):
    _name = 'myaccounting.search'
    _description = 'البحث العام'

    # ------------------------------------------------------------------

    @api.model
    def _rank(self, query, *values):
        """0 مطابقة تامة، 1 يبدأ بالنص، 2 يحتويه، 3 غير ذلك."""
        needle = query.casefold()
        best = 3
        for value in values:
            text = (value or '').casefold()
            if not text:
                continue
            if text == needle:
                return 0
            if text.startswith(needle):
                best = min(best, 1)
            elif needle in text:
                best = min(best, 2)
        return best

    @api.model
    def _move_items(self, query, limit):
        Move = self.env['myaccounting.move']
        domain = ['|', '|', ('name', 'ilike', query), ('ref', 'ilike', query),
                  ('journal', 'ilike', query)]
        moves = Move.search(domain, limit=limit * 3, order='sort_key desc')
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
                'rank': self._rank(query, move.name, move.ref, move.journal),
            })
        return items

    @api.model
    def _account_items(self, query, limit):
        Account = self.env['myaccounting.account']
        accounts = Account.search(
            ['|', ('code', 'ilike', query), ('name', 'ilike', query)],
            limit=limit * 3, order='code_path')
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
            'rank': self._rank(query, account.code, account.name),
        } for account in accounts]

    @api.model
    def _line_items(self, query, limit):
        """بنود القيود: يُفتح قيدها، فالبند وحده لا معنى له."""
        Line = self.env['myaccounting.move.line']
        domain = [('name', 'ilike', query)]
        amount = _normalize(query)
        if AMOUNT_RE.match(amount):
            value = float(amount)
            domain = ['|', '|', ('name', 'ilike', query),
                      ('debit', '=', value), ('credit', '=', value)]
        lines = Line.search(domain, limit=limit * 4, order='move_sort_key desc, id desc')
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
                'rank': self._rank(query, line.name),
            })
        return items

    # ------------------------------------------------------------------

    @api.model
    def search_all(self, query, limit=6):
        """نتائج مجمّعة حسب النوع، لكل نوع أهمّ نتائجه."""
        query = (query or '').strip()
        if len(query) < 2:
            return {'query': query, 'groups': [], 'total': 0}
        limit = max(1, int(limit))
        groups = []
        total = 0
        for label, items in (
            ('القيود والسندات', self._move_items(query, limit)),
            ('الحسابات', self._account_items(query, limit)),
            ('بنود القيود', self._line_items(query, limit)),
        ):
            items.sort(key=lambda item: (item['rank'], item['title']))
            total += len(items)
            if items:
                groups.append({'label': label, 'items': items[:limit],
                               'more': max(0, len(items) - limit)})
        return {'query': query, 'groups': groups, 'total': total}
