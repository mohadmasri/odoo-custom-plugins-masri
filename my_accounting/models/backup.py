from datetime import datetime

from odoo import api, models
from odoo.exceptions import UserError


class MyAccountingBackup(models.AbstractModel):
    _name = 'myaccounting.backup'
    _description = 'أداة النسخ الاحتياطي والاستعادة'

    @api.model
    def get_backup_data(self):
        accounts = self.env['myaccounting.account'].search([], order='id')
        moves = self.env['myaccounting.move'].search([], order='id')
        return {
            'version': 1,
            'exported_at': datetime.now().isoformat(),
            'accounts': [{
                'id': account.id,
                'name': account.name,
                'code': account.code,
                'parent_id': account.parent_id.id or None,
                'note': account.note or '',
                'active': account.active,
                'is_essential': account.is_essential,
                'reviewed': account.reviewed,
                'reviewed_by': account.reviewed_by.id or None,
                'reviewed_date': account.reviewed_date.isoformat() if account.reviewed_date else None,
                'currency_code': account.currency_id.name or None,
                'company_name': account.company_id.name or None,
            } for account in accounts],
            'moves': [{
                'id': move.id,
                'name': move.name,
                'date': move.date.isoformat() if move.date else None,
                'ref': move.ref or '',
                'journal': move.journal or '',
                'state': move.state,
                'ledger_month': move.ledger_month,
                'ledger_year': move.ledger_year,
                'import_notes': move.import_notes or '',
                'import_notes_reviewed': move.import_notes_reviewed,
                'currency_code': move.currency_id.name or None,
                'company_name': move.company_id.name or None,
                'lines': [{
                    'account_id': line.account_id.id,
                    'pending_account_name': line.pending_account_name or '',
                    'name': line.name or '',
                    'debit': line.debit,
                    'credit': line.credit,
                } for line in move.line_ids],
            } for move in moves],
        }

    def _resolve_currency_id(self, currency_code):
        if not currency_code:
            return False
        currency = self.env['res.currency'].search([('name', '=', currency_code)], limit=1)
        return currency.id if currency else False

    def _resolve_company_id(self, company_name):
        if not company_name:
            return False
        company = self.env['res.company'].search([('name', '=', company_name)], limit=1)
        return company.id if company else False

    @api.model
    def restore_backup_data(self, data):
        if not isinstance(data, dict) or 'accounts' not in data or 'moves' not in data:
            raise UserError('ملف النسخة الاحتياطية غير صالح أو تالف.')

        Account = self.env['myaccounting.account']
        Move = self.env['myaccounting.move']

        # حذف كل شيء أولاً. حذف القيود يحذف بنودها تلقائياً (cascade)،
        # وفك ارتباط الحسابات بآبائها قبل حذفها يتجنب قيد الحماية (restrict) على parent_id.
        Move.search([]).with_context(force_delete=True).unlink()
        existing_accounts = Account.search([])
        existing_accounts.write({'parent_id': False})
        existing_accounts.with_context(force_delete=True).unlink()

        # الخطوة الأولى: إنشاء الحسابات كلها دون ربط بالأب، مع حفظ خريطة الأرقام القديمة->الجديدة
        account_id_map = {}
        for acc in data['accounts']:
            account_vals = {
                'name': acc.get('name') or '/',
                'code': acc.get('code') or '/',
                'note': acc.get('note') or False,
                'active': acc.get('active', True),
                'is_essential': acc.get('is_essential', False),
                'reviewed': acc.get('reviewed', False),
                'reviewed_by': acc.get('reviewed_by') or False,
                'reviewed_date': acc.get('reviewed_date') or False,
            }
            currency_id = self._resolve_currency_id(acc.get('currency_code'))
            if currency_id:
                account_vals['currency_id'] = currency_id
            company_id = self._resolve_company_id(acc.get('company_name'))
            if company_id:
                account_vals['company_id'] = company_id
            new_account = Account.create(account_vals)
            account_id_map[acc['id']] = new_account.id

        # الخطوة الثانية: إعادة ربط التسلسل الهرمي بين الحسابات
        for acc in data['accounts']:
            if acc.get('parent_id') and acc['parent_id'] in account_id_map:
                Account.browse(account_id_map[acc['id']]).write({
                    'parent_id': account_id_map[acc['parent_id']],
                })

        # إعادة إنشاء القيود وبنودها
        for mv in data['moves']:
            line_cmds = []
            for line in mv.get('lines', []):
                new_account_id = account_id_map.get(line.get('account_id'))
                # بنود "غير مكتملة" (مستوردة بلا حساب) تُستعاد باسم الحساب المعلّق
                if not new_account_id and not line.get('pending_account_name'):
                    continue
                line_cmds.append((0, 0, {
                    'account_id': new_account_id or False,
                    'pending_account_name': line.get('pending_account_name') or False,
                    'name': line.get('name') or False,
                    'debit': line.get('debit') or 0.0,
                    'credit': line.get('credit') or 0.0,
                }))
            move_vals = {
                'name': mv.get('name') or '/',
                'date': mv.get('date') or False,
                'ref': mv.get('ref') or False,
                'journal': mv.get('journal') or False,
                'state': mv.get('state') or 'draft',
                'line_ids': line_cmds,
            }
            # ندعم أيضاً استعادة نسخ احتياطية قديمة لا تحتوي على هذه الحقول،
            # فنترك القيم الافتراضية تُطبَّق تلقائياً عندئذ.
            if mv.get('import_notes'):
                move_vals['import_notes'] = mv['import_notes']
                move_vals['import_notes_reviewed'] = mv.get('import_notes_reviewed', False)
            if mv.get('ledger_month'):
                move_vals['ledger_month'] = mv['ledger_month']
            if mv.get('ledger_year'):
                move_vals['ledger_year'] = mv['ledger_year']
            currency_id = self._resolve_currency_id(mv.get('currency_code'))
            if currency_id:
                move_vals['currency_id'] = currency_id
            company_id = self._resolve_company_id(mv.get('company_name'))
            if company_id:
                move_vals['company_id'] = company_id
            Move.create(move_vals)

        return {
            'accounts_count': len(data['accounts']),
            'moves_count': len(data['moves']),
        }
