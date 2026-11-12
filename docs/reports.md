# التقارير

التقارير للقراءة فقط. يقرأ الخادم جداول الدوام والمالية مباشرةً ويحسب الإجماليات على كامل النتائج المطابقة للفلاتر. ترجع المبالغ في JSON كنصوص عشرية بمنزلتين، مع إجراء الحسابات باستخدام PostgreSQL أو `Decimal`.

## المسارات وطرق العرض

| المسار | الصلاحية | قيم `view` (الافتراضي أولًا) |
| --- | --- | --- |
| `GET /reports/attendance` | `reports.attendance` | `sessions`، `employees` |
| `GET /reports/absence` | `reports.absence` | `records`، `employees` |
| `GET /reports/financial` | `reports.financial` | `employees`، `entries`، `advances`، `debts`، `settlements` |
| `GET /reports/payments` | `reports.payments` | `payments`، `byEmployee`، `byPeriod`، `byMethod`، `byExecutor` |

الأدمن لديه جميع الصلاحيات. يتطلب `GET /reports/options?search=...` واحدة على الأقل من صلاحيات التقارير، ويعيد معرّفات وأسماء الأقسام وأول 50 اسمًا وكودًا مطابقًا من الموظفين لتعبئة منتقي النطاق. يُضاف الموظف المحفوظ في `selectedId` إن كان خارج نتائج البحث.

## الاستعلام

- `from` و`to` بصيغة `YYYY-MM-DD`، والطرفان شاملان. الافتراضي أول الشهر إلى اليوم في منطقة الإعدادات (`Asia/Gaza` افتراضيًا). أعمدة التاريخ تُقارن كتاريخ محلي، والأوقات تُقارن من منتصف ليل البداية إلى منتصف ليل اليوم التالي للنهاية حصريًا.
- `employeeId` لنطاق موظف واحد، أو `departmentId` لقسم واحد، أو اتركهما للجميع. الموظف له الأولوية عند إرسال الحقلين. الدوام يتبع قسم الوردية، والتقارير الأخرى تتبع القسم الحالي للموظف.
- `search` يطابق جزءًا من اسم الموظف أو كوده. الدفعات تبحث أيضًا في المستلم والمرجع.
- `page` يبدأ من 1، و`pageSize` افتراضيًا 25 وحده 200. `sortDir=asc|desc` يضبط ترتيب العرض.
- `columns` مفاتيح مفصولة بفاصلة، مثل `columns=employeeName,workedMinutes`. يعيد `availableColumns` القائمة البيضاء لكل عرض، و`columns` المختارة مع التسميات والأنواع. يُرفض أي عمود مجهول.
- تتضمن الاستجابة `items` و`total` و`totalPages` و`totals` للأعمدة المختارة، إضافة إلى ملخص ورسوم وملاحظات الحساب.

| التقرير | فلاتر إضافية |
| --- | --- |
| الدوام | `status=OPEN\|CLOSED`، `approvalStatus=DRAFT\|IN_REVIEW\|APPROVED`، `lateOnly=true` |
| الغياب | `type` من أنواع الإجازة والغياب، `pay=paid\|unpaid`، `status=PENDING\|APPROVED\|REJECTED\|CANCELLED\|ALL` |
| المالية | `periodStatus=CLOSED\|DRAFT\|IN_REVIEW\|READY_FOR_APPROVAL\|ALL` للمستحقات، `accountStatus=OPEN\|SETTLED\|CANCELLED` للسلف والديون، `outstandingOnly=true` للأرصدة، `targetType=PAYROLL_ENTRY\|ADVANCE\|DEBT\|ADJUSTMENT` للتسويات |
| الدفعات | `method=CASH\|BANK_TRANSFER\|E_WALLET`، `type=SALARY_PAYMENT\|ADVANCE_DISBURSEMENT\|ALL`، `status=POSTED\|REVERSED\|ALL`، `executorId` و`periodId` |

## قواعد الحساب

- **الدوام:** يُستثنى `VOIDED` وتُستخدم `workedMinutes` المحفوظة. تُعرض الاستراحات المنتهية حسب نوعها. يُعرض الإضافي المعتمد وقيد الاعتماد منفصلين. يؤخذ التأخير من وردية مجدولة في اليوم نفسه، أو من نمط أسبوعي ثابت وسارٍ. إذا انقسمت الوردية المجدولة إلى أكثر من تسجيل، يقاس التأخير عند أول حضور والانصراف المبكر عند آخر انصراف.
- **الغياب:** المصدر `leave_records` فقط. عدد الأيام تقويمي ويُحسب داخل تقاطع السجل مع الفترة. نوع السجل يحدد المدفوع وغير المدفوع، والحالتان الافتراضيتان المعتمدة والمعلّقة.
- **المالية:** يُنسب المستحق إلى يوم انتهاء فترة الراتب، وتُعرض الفترات المغلقة افتراضيًا. «المدفوع» يشمل دفعات المستحق والتسويات السارية عليه. أرصدة السلف والديون الحالية تظهر في الملخص، وتُختار في التفاصيل الحسابات التي نشأت في الفترة. يعرض تقرير التسويات التوزيعات ويجمع مبالغ العمليات المسجّلة فقط.
- **الدفعات:** الافتراضي دفعات الرواتب المسجّلة، ويمكن تضمين صرف السلف. تُستبعد الدفعات المعكوسة من الإجمالي والتجميع. المنفّذ هو `paidById`، أو `createdById` عند غيابه.

## التصدير

أضف `format=xlsx` أو `format=pdf` إلى الاستعلام نفسه. يتجاهل التصدير رقم الصفحة وحجمها ويضم جميع النتائج المطابقة حتى 5000 صف. يسجّل الخادم `report.exported` مع نوع التقرير والعرض والفترة والنطاق والأعمدة وعدد الصفوف عند طلب تنزيل صالح. الحد الوقائي لمصادر الدوام والغياب التي تُجمع في الذاكرة 50,000 سجل.

- ExcelJS يكتب ورقة RTL بعناوين عربية وتواريخ وأرقام فعلية ومدد بنمط `[h]:mm`. يُعرض صف الإجماليات عند اختيار أعمدة قابلة للجمع.
- PDFKit وFontkit يشكّلان العربية، و`bidi-js` يحدد الترتيب البصري للمقاطع المختلطة. تُضمَّن نسختا Regular وBold من **Noto Naskh Arabic** داخل PDF حسب المحارف المستعملة. رخصة **SIL Open Font License 1.1** تسمح بالتضمين وإعادة التوزيع، وملفها محفوظ مع الخطين في `apps/api/assets/fonts/OFL.txt`. المقاطع اللاتينية وعلامات الترقيم اللاتينية تستخدم Helvetica القياسي. عُرضت عينة عبر Poppler وفُحص اتصال الحروف وموضع الأعمدة والأرقام والتواريخ وكود موظف لاتيني.
- يعرض PDF النص في ثلاثة أسطر لكل خلية على الأكثر، وتظهر علامة الحذف إذا تجاوز النص المساحة. يمكن الرجوع إلى Excel لقراءة النص الكامل.

## مفاتيح الأعمدة

يمكن الحصول على الأنواع والتسميات العربية وقيم الأعمدة الافتراضية في `availableColumns`.

- **attendance / sessions** `employeeCode`، `employeeName`، `department`، `workDate`، `checkInAt`، `checkOutAt`، `workedMinutes`، `breakCount`، `unpaidBreakMinutes`، `paidBreakMinutes`، `scheduledStart`، `lateMinutes`، `earlyLeaveMinutes`، `overtimeApprovedMinutes`، `overtimePendingMinutes`، `status`، `approvalStatus`، `source`
- **attendance / employees** `employeeCode`، `employeeName`، `department`، `daysWorked`، `sessionsCount`، `workedMinutes`، `breakCount`، `unpaidBreakMinutes`، `paidBreakMinutes`، `lateCount`، `lateMinutes`، `earlyLeaveMinutes`، `overtimeApprovedMinutes`، `overtimePendingMinutes`، `openSessions`
- **absence / records** `employeeCode`، `employeeName`، `department`، `type`، `startDate`، `endDate`، `daysInRange`، `paidDays`، `unpaidDays`، `totalDays`، `status`، `affectsPay`، `reason`، `recordedBy`، `decidedBy`، `decidedAt`
- **absence / employees** `employeeCode`، `employeeName`، `department`، `recordsCount`، `leaveDays`، `absenceDays`، `paidDays`، `unpaidDays`، `daysInRange`، `pendingDays`
- **financial / employees** `employeeCode`، `employeeName`، `department`، `grossAmount`، `deductionsAmount`، `netAmount`، `paidAmount`، `unpaidAmount`، `advancesDisbursed`، `advancesOutstanding`، `debtsIncurred`، `debtsOutstanding`، `settlementsAmount`
- **financial / entries** `employeeCode`، `employeeName`، `department`، `periodLabel`، `periodStart`، `periodEnd`، `frequency`، `periodStatus`، `regularWage`، `overtimeWage`، `bonuses`، `otherDeductions`، `absenceDeductions`، `adjustments`، `grossAmount`، `deductionsAmount`، `netAmount`، `paidAmount`، `unpaidAmount`
- **financial / advances** `employeeCode`، `employeeName`، `department`، `disbursedAt`، `principalAmount`، `repaidAmount`، `remainingBalance`، `status`، `note`، `createdBy`
- **financial / debts** `employeeCode`، `employeeName`، `department`، `incurredAt`، `principalAmount`، `repaidAmount`، `remainingBalance`، `status`، `reason`، `createdBy`
- **financial / settlements** `employeeCode`، `employeeName`، `department`، `occurredAt`، `targetType`، `target`، `amount`، `status`، `reference`، `note`، `createdBy`
- **payments / payments** `occurredAt`، `employeeCode`، `employeeName`، `department`، `type`، `amount`، `method`، `paidBy`، `receivedBy`، `reference`، `period`، `status`، `note`، `createdBy`
- **payments / byEmployee** `employeeCode`، `employeeName`، `department`، `paymentsCount`، `amount`
- **payments / byPeriod** `period`، `periodStart`، `periodEnd`، `paymentsCount`، `amount`
- **payments / byMethod** `method`، `paymentsCount`، `amount`
- **payments / byExecutor** `executor`، `executorUsername`، `paymentsCount`، `amount`
