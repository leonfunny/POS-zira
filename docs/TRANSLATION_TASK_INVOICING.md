# Translation Task: Invoicing Module

## Overview
Cần dịch các chuỗi text của module Invoicing sang 5 ngôn ngữ còn lại.

## File cần chỉnh sửa
```
/var/www/enail/print-agent/src/renderer/i18n/translations.ts
```

## Ngôn ngữ cần dịch
| Code | Language | Line bắt đầu | Status |
|------|----------|--------------|--------|
| `en` | English | ~282 | ✅ Done |
| `pl` | Polish | ~2015 | ✅ Done |
| `vi` | Vietnamese | ~420 | ❌ Cần dịch |
| `tr` | Turkish | ~686 | ❌ Cần dịch |
| `zh` | Chinese | ~952 | ❌ Cần dịch |
| `uk` | Ukrainian | ~1218 | ❌ Cần dịch |
| `ru` | Russian | ~1484 | ❌ Cần dịch |

## Vị trí thêm translations
Thêm translations vào **cuối mỗi language section**, trước dấu `},` kết thúc section.

Ví dụ cho Vietnamese (vi), tìm đến khoảng line 680 (cuối section vi), thêm trước `},`:

```typescript
    // ... existing translations ...
    'settings.idleTimeoutDesc': '...',  // <-- dòng cuối hiện tại

    // Invoicing (THÊM VÀO ĐÂY)
    'invoice.title': 'Hóa đơn',
    'invoice.quickInvoice': 'Hóa đơn nhanh',
    // ... tiếp tục ...
  },  // <-- kết thúc section vi

  // Turkish
  tr: {
```

## Các chuỗi cần dịch (copy từ English)

```typescript
    // Invoicing
    'invoice.title': 'Invoicing',
    'invoice.quickInvoice': 'Quick Invoice',
    'invoice.invoiceList': 'Invoice List',
    'invoice.customers': 'Customers',
    'invoice.sellerSettings': 'Seller Settings',
    'invoice.newInvoice': 'New Invoice',
    'invoice.editInvoice': 'Edit Invoice',
    'invoice.type': 'Type',
    'invoice.status': 'Status',
    'invoice.number': 'Number',
    'invoice.date': 'Date',
    'invoice.customer': 'Customer',
    'invoice.total': 'Total',
    'invoice.items': 'Items',
    'invoice.addItem': 'Add item',
    'invoice.removeItem': 'Remove',

    // Invoice types
    'invoice.type.receipt': 'Receipt',
    'invoice.type.vat': 'VAT Invoice',
    'invoice.type.proforma': 'Proforma',
    'invoice.type.correction': 'Correction',
    'invoice.type.advance': 'Advance',

    // Invoice statuses
    'invoice.status.draft': 'Draft',
    'invoice.status.issued': 'Issued',
    'invoice.status.sent': 'Sent',
    'invoice.status.paid': 'Paid',
    'invoice.status.partially_paid': 'Partially Paid',
    'invoice.status.overdue': 'Overdue',
    'invoice.status.cancelled': 'Cancelled',

    // Invoice form
    'invoice.issueDate': 'Issue Date',
    'invoice.saleDate': 'Sale Date',
    'invoice.dueDate': 'Due Date',
    'invoice.paymentMethod': 'Payment Method',
    'invoice.paymentMethod.cash': 'Cash',
    'invoice.paymentMethod.card': 'Card',
    'invoice.paymentMethod.transfer': 'Bank Transfer',
    'invoice.paymentMethod.blik': 'BLIK',
    'invoice.notes': 'Notes',
    'invoice.internalNotes': 'Internal Notes',

    // Invoice items
    'invoice.item.name': 'Name',
    'invoice.item.sku': 'SKU',
    'invoice.item.unit': 'Unit',
    'invoice.item.quantity': 'Qty',
    'invoice.item.unitPrice': 'Unit Price',
    'invoice.item.vatRate': 'VAT %',
    'invoice.item.discount': 'Discount %',
    'invoice.item.totalNet': 'Net',
    'invoice.item.totalGross': 'Gross',

    // Invoice totals
    'invoice.subtotalNet': 'Subtotal (net)',
    'invoice.totalVat': 'Total VAT',
    'invoice.totalGross': 'Total (gross)',
    'invoice.vatSummary': 'VAT Summary',

    // Invoice actions
    'invoice.save': 'Save',
    'invoice.saveDraft': 'Save Draft',
    'invoice.issue': 'Issue Invoice',
    'invoice.cancel': 'Cancel Invoice',
    'invoice.cancelReason': 'Enter cancellation reason:',
    'invoice.duplicate': 'Duplicate',
    'invoice.markPaid': 'Mark as Paid',
    'invoice.print': 'Print',
    'invoice.printThermal': 'Print (Thermal)',
    'invoice.printA4': 'Print (A4)',
    'invoice.download': 'Download PDF',

    // Customer fields
    'invoice.customerName': 'Customer Name',
    'invoice.customerPlaceholder': 'Search customer...',
    'invoice.noCustomersFound': 'No customers found',
    'invoice.addNewCustomer': 'Add new customer',
    'invoice.newCustomer': 'New Customer',
    'invoice.isCompany': 'Company',
    'invoice.company': 'Company',
    'invoice.person': 'Individual',

    // Seller/Address fields
    'invoice.companyName': 'Company Name',
    'invoice.address': 'Address',
    'invoice.street': 'Street',
    'invoice.city': 'City',
    'invoice.postalCode': 'Postal Code',
    'invoice.country': 'Country',
    'invoice.email': 'Email',
    'invoice.phone': 'Phone',
    'invoice.contact': 'Contact',

    // Bank details
    'invoice.bankDetails': 'Bank Details',
    'invoice.bankName': 'Bank Name',
    'invoice.bankAccount': 'Bank Account',

    // Invoice settings
    'invoice.invoiceSettings': 'Invoice Settings',
    'invoice.paymentTermDays': 'Payment Term (days)',
    'invoice.isVatRegistered': 'VAT Registered',
    'invoice.invoiceFooter': 'Invoice Footer',
    'invoice.invoiceFooterPlaceholder': 'Thank you for your business!',

    // Filters
    'invoice.filter.allStatuses': 'All Statuses',
    'invoice.filter.allTypes': 'All Types',
    'invoice.searchPlaceholder': 'Search by number, customer or NIP...',
    'invoice.noInvoices': 'No invoices found',

    // Errors
    'invoice.error.companyNameRequired': 'Company name is required',
    'invoice.error.nipInvalid': 'NIP must be exactly 10 digits',
    'invoice.error.addressRequired': 'Street, city and postal code are required',
    'invoice.error.customerRequired': 'Customer is required',
    'invoice.error.itemsRequired': 'At least one item is required',
    'invoice.error.customerNameRequired': 'Customer name is required',
    'invoice.error.sellerNotConfigured': 'Please configure seller settings first',

    // Common
    'common.add': 'Add',
    'common.edit': 'Edit',
    'common.delete': 'Delete',
    'common.save': 'Save',
    'common.cancel': 'Cancel',
    'common.close': 'Close',
    'common.back': 'Back',
    'common.refresh': 'Refresh',
    'common.saving': 'Saving...',
    'common.loading': 'Loading...',
    'common.actions': 'Actions',
```

## Workflow

### Step 1: Mở file translations.ts
```bash
code /var/www/enail/print-agent/src/renderer/i18n/translations.ts
```

### Step 2: Tìm vị trí section cần dịch
- Vietnamese (vi): Tìm `vi: {`, scroll đến cuối section (~line 680)
- Turkish (tr): Tìm `tr: {`, scroll đến cuối section (~line 946)
- Chinese (zh): Tìm `zh: {`, scroll đến cuối section (~line 1212)
- Ukrainian (uk): Tìm `uk: {`, scroll đến cuối section (~line 1478)
- Russian (ru): Tìm `ru: {`, scroll đến cuối section (~line 1744)

### Step 3: Copy block translations và dịch
Copy block ở trên, paste vào cuối mỗi section, rồi dịch sang ngôn ngữ tương ứng.

### Step 4: Test build
```bash
cd /var/www/enail/print-agent
npm run build
```

### Step 5: Test UI
Chạy app, đổi ngôn ngữ trong Settings, kiểm tra tab Invoicing.

## Lưu ý quan trọng

1. **Giữ nguyên key** - Chỉ dịch value, KHÔNG thay đổi key
   ```typescript
   // ĐÚNG
   'invoice.title': 'Hóa đơn',

   // SAI - đổi key
   'hoadon.tieude': 'Hóa đơn',
   ```

2. **Không dịch các từ kỹ thuật**
   - NIP, VAT, BLIK, SKU - giữ nguyên
   - A4, PDF - giữ nguyên

3. **Placeholder có thể giữ format**
   ```typescript
   'invoice.searchPlaceholder': 'Tìm theo số, khách hàng hoặc NIP...',
   ```

4. **Escape quotes nếu cần**
   ```typescript
   'invoice.invoiceFooterPlaceholder': 'Cảm ơn quý khách!',
   ```

## Reference: Polish translation (để tham khảo context)

```typescript
    // Invoicing
    'invoice.title': 'Faktury',
    'invoice.quickInvoice': 'Szybka faktura',
    'invoice.invoiceList': 'Lista faktur',
    'invoice.customers': 'Klienci',
    'invoice.sellerSettings': 'Dane sprzedawcy',
    'invoice.newInvoice': 'Nowa faktura',
    'invoice.editInvoice': 'Edytuj fakturę',
    'invoice.type': 'Typ',
    'invoice.status': 'Status',
    'invoice.number': 'Numer',
    'invoice.date': 'Data',
    'invoice.customer': 'Klient',
    'invoice.total': 'Razem',
    'invoice.items': 'Pozycje',
    'invoice.addItem': 'Dodaj pozycję',
    'invoice.removeItem': 'Usuń',

    // Invoice types
    'invoice.type.receipt': 'Paragon',
    'invoice.type.vat': 'Faktura VAT',
    'invoice.type.proforma': 'Proforma',
    'invoice.type.correction': 'Korekta',
    'invoice.type.advance': 'Faktura zaliczkowa',

    // Invoice statuses
    'invoice.status.draft': 'Wersja robocza',
    'invoice.status.issued': 'Wystawiona',
    'invoice.status.sent': 'Wysłana',
    'invoice.status.paid': 'Opłacona',
    'invoice.status.partially_paid': 'Częściowo opłacona',
    'invoice.status.overdue': 'Przeterminowana',
    'invoice.status.cancelled': 'Anulowana',
    // ... (xem đầy đủ trong file translations.ts section pl)
```

## Deadline
[ ] Cần hoàn thành trước: ___________

## Contact
Nếu có câu hỏi về context hoặc meaning, liên hệ: ___________
