import io
import json

import xlsxwriter

from odoo import fields, http
from odoo.http import request


class BackupController(http.Controller):

    @http.route('/my_accounting/backup/download', type='http', auth='user')
    def download_backup(self, **kwargs):
        data = request.env['myaccounting.backup'].get_backup_data()
        content = json.dumps(data, ensure_ascii=False, indent=2).encode('utf-8')
        filename = 'my_accounting_backup_%s.json' % data['exported_at'][:10]
        return request.make_response(
            content,
            headers=[
                ('Content-Type', 'application/json; charset=utf-8'),
                ('Content-Disposition', f'attachment; filename="{filename}"'),
            ],
        )


class JournalImportController(http.Controller):

    @http.route('/my_accounting/journal_import/template', type='http', auth='user')
    def download_import_template(self, **kwargs):
        """يولّد قالب Excel جاهزاً لتعبئته باستيراد قيود متعدّدة."""
        content = request.env['myaccounting.move'].build_import_template_xlsx()
        return request.make_response(
            content,
            headers=[
                ('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
                ('Content-Disposition', 'attachment; filename="journal_entries_template.xlsx"'),
            ],
        )


class GeneralLedgerController(http.Controller):

    @staticmethod
    def _ledger_cell(amount, side):
        """قيمة خانة الحساب: فارغة إن لم يُدخل شيء، و0 إن أُدخل صفر يدوياً."""
        if not amount:
            return ''
        return amount[side] or (0 if amount.get(f'{side}_zero') else '')

    @http.route('/my_accounting/general_ledger/xlsx', type='http', auth='user')
    def export_general_ledger_xlsx(self, year=None, month=None, states=None, **kwargs):
        # نفس فلتر الحالة المطبَّق على الشاشة، ليطابق ملف Excel ما يراه المستخدم
        state_list = [state for state in (states or '').split(',') if state]
        data = request.env['myaccounting.move'].get_general_ledger_matrix(year, month, state_list)
        accounts = data['accounts']

        output = io.BytesIO()
        workbook = xlsxwriter.Workbook(output, {'in_memory': True})
        sheet = workbook.add_worksheet('دفتر الأستاذ العام')
        sheet.right_to_left()

        header_fmt = workbook.add_format({'bold': True, 'bg_color': '#f2f2f2', 'border': 1, 'text_wrap': True})
        total_fmt = workbook.add_format({'bold': True, 'bg_color': '#f2f2f2', 'border': 1, 'num_format': '#,##0.000'})
        num_fmt = workbook.add_format({'border': 1, 'num_format': '#,##0.000'})
        text_fmt = workbook.add_format({'border': 1})

        # طباعة ملف Excel أيضاً في صفحة واحدة أفقية
        sheet.set_landscape()
        sheet.fit_to_pages(1, 1)

        headers = ['#', 'القيد', 'التاريخ', 'المرجع', 'إجمالي مدين', 'إجمالي دائن']
        for acc in accounts:
            headers.append(f"{acc['code']} - {acc['name']} (مدين)")
            headers.append(f"{acc['code']} - {acc['name']} (دائن)")
        for c, h in enumerate(headers):
            sheet.write(0, c, h, header_fmt)

        row_idx = 1
        for row in data['rows']:
            col = 0
            sheet.write(row_idx, col, row['seq'], text_fmt); col += 1
            sheet.write(row_idx, col, row['move_name'], text_fmt); col += 1
            sheet.write(row_idx, col, row['date'] or '', text_fmt); col += 1
            sheet.write(row_idx, col, row['ref'] or '', text_fmt); col += 1
            sheet.write(row_idx, col, row['total_debit'], num_fmt); col += 1
            sheet.write(row_idx, col, row['total_credit'], num_fmt); col += 1
            for acc in accounts:
                amt = row['amounts'].get(acc['id'])
                sheet.write(row_idx, col, self._ledger_cell(amt, 'debit'), num_fmt); col += 1
                sheet.write(row_idx, col, self._ledger_cell(amt, 'credit'), num_fmt); col += 1
            row_idx += 1

        col = 0
        sheet.write(row_idx, col, 'الإجمالي', header_fmt); col += 1
        sheet.write(row_idx, col, '', header_fmt); col += 1
        sheet.write(row_idx, col, '', header_fmt); col += 1
        sheet.write(row_idx, col, '', header_fmt); col += 1
        sheet.write(row_idx, col, data['grand_debit'], total_fmt); col += 1
        sheet.write(row_idx, col, data['grand_credit'], total_fmt); col += 1
        for acc in accounts:
            t = data['totals'].get(acc['id'], {'debit': 0, 'credit': 0})
            sheet.write(row_idx, col, t['debit'], total_fmt); col += 1
            sheet.write(row_idx, col, t['credit'], total_fmt); col += 1

        sheet.set_column(0, 0, 6)
        sheet.set_column(1, 3, 14)
        sheet.set_column(4, 4 + 1 + len(accounts) * 2, 13)

        workbook.close()
        output.seek(0)
        filename = f"general_ledger_{year}_{int(month):02d}.xlsx"
        return request.make_response(
            output.read(),
            headers=[
                ('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
                ('Content-Disposition', f'attachment; filename="{filename}"'),
            ],
        )

    @http.route('/my_accounting/trial_balance/xlsx', type='http', auth='user')
    def export_trial_balance_xlsx(self, date_from=None, date_to=None, ledger_from=None,
                                  ledger_to=None, states=None, show_empty=None, **kwargs):
        """تصدير ميزان المراجعة بنفس فلاتر الشاشة."""
        import io
        import xlsxwriter

        state_list = [state for state in (states or '').split(',') if state]
        data = request.env['myaccounting.account'].get_trial_balance(
            date_from or False, date_to or False, ledger_from or False, ledger_to or False,
            state_list, bool(show_empty))

        output = io.BytesIO()
        workbook = xlsxwriter.Workbook(output, {'in_memory': True})
        sheet = workbook.add_worksheet('ميزان المراجعة')
        sheet.right_to_left()

        header_fmt = workbook.add_format({'bold': True, 'bg_color': '#f2f2f2', 'border': 1, 'text_wrap': True})
        total_fmt = workbook.add_format({'bold': True, 'bg_color': '#f2f2f2', 'border': 1, 'num_format': '#,##0.000'})
        num_fmt = workbook.add_format({'border': 1, 'num_format': '#,##0.000'})
        text_fmt = workbook.add_format({'border': 1})

        period = (f"من {date_from or 'البداية'} إلى {data['date_to']}" if (date_from or date_to)
                  else f"من شهر {ledger_from or ''} إلى {data['ledger_to'] or ledger_to or ''}")
        sheet.write(0, 0, f'ميزان المراجعة — {period}', header_fmt)
        headers = ['الرمز', 'الحساب', 'الحساب الأب', 'رصيد افتتاحي', 'مدين', 'دائن', 'رصيد ختامي']
        for col, title in enumerate(headers):
            sheet.write(2, col, title, header_fmt)

        row_idx = 3
        for row in data['rows']:
            sheet.write(row_idx, 0, row['code'], text_fmt)
            sheet.write(row_idx, 1, row['name'], text_fmt)
            sheet.write(row_idx, 2, row['parent'], text_fmt)
            sheet.write(row_idx, 3, row['opening'], num_fmt)
            sheet.write(row_idx, 4, row['debit'], num_fmt)
            sheet.write(row_idx, 5, row['credit'], num_fmt)
            sheet.write(row_idx, 6, row['closing'], num_fmt)
            row_idx += 1

        sheet.write(row_idx, 0, 'الإجمالي', header_fmt)
        sheet.write(row_idx, 1, '', header_fmt)
        sheet.write(row_idx, 2, '', header_fmt)
        for offset, key in enumerate(('opening', 'debit', 'credit', 'closing'), start=3):
            sheet.write(row_idx, offset, data['totals'][key], total_fmt)

        sheet.set_column(0, 0, 10)
        sheet.set_column(1, 2, 28)
        sheet.set_column(3, 6, 15)
        sheet.freeze_panes(3, 0)
        sheet.set_landscape()
        sheet.fit_to_pages(1, 0)

        workbook.close()
        output.seek(0)
        filename = 'trial_balance.xlsx'
        return request.make_response(
            output.read(),
            headers=[
                ('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
                ('Content-Disposition', f'attachment; filename="{filename}"'),
            ],
        )
