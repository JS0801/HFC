/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/file', 'N/search', 'N/record', 'N/format', 'N/runtime'], function (file, search, record, format, runtime) {
    var RETURN_FOLDER_ID = '329224';
    var PROCESSED_FOLDER_ID = '329225';
    var DUPLICATE_FOLDER_ID = '398330';
    var FILE_ID_PARAM = 'custscript_fileid';
    var DAYS_BACK = 30;
    var BATCH_FIELD = 'custbody_9997_pfa_record';
    var OPERATING_SEQ_FIELD = 'custitem_operating_seq';
    var NAF_SEQ_FIELD = 'custitem_naf_seq';
    var VOID_MEMO_TEXT = 'ACH RETURN VOIDED';
    var CUSTOMER_JE_MEMO_TEXT = 'ACH Return Payment Offset';
    var NEW_PAYMENT_MEMO_TEXT = 'ACH Return Reallocation';
    var JE_INVOICE_FIELD = 'custbody_ns_acs_created_from';
    var AP_MEMO_TEXT = 'NSF Bill Payment Reversal';
    var UNAPPLIED_DATE_FIELD = 'custbody_datetimeunapplied';
    var PROCESS_CUSTOMER = 'CUSTOMER_PAYMENT';
    var PROCESS_BILL = 'BILL_PAYMENT';

    function getInputData() {
        var fileObj = getReturnFile();

        if (!fileObj) return [];

        if (isDuplicateFile(fileObj.name)) {
            fileObj.description = 'Duplicate';
            fileObj.folder = DUPLICATE_FOLDER_ID;
            fileObj.save();

            log.audit('ACH Return Duplicate File Moved', {
                fileId: fileObj.id,
                fileName: fileObj.name,
                movedToFolder: DUPLICATE_FOLDER_ID
            });

            return [];
        }

        var rows = parseCsv(fileObj.getContents());
        var failedLookup = getReturnedPayments(rows, fileObj.id, fileObj.name);
        var failedRefs = Object.keys(failedLookup);

        log.audit('ACH Return CSV Loaded', {
            fileId: fileObj.id,
            fileName: fileObj.name,
            rows: rows.length,
            failedRefs: failedRefs.length,
            failedAmount: failedRefs.reduce(function (total, ref) {
                return round(total + failedLookup[ref].returnedAmount);
            }, 0)
        });

        if (!failedRefs.length) return [];

        var tranLookup = findReturnedTransactions(failedLookup);
        var customerFailedLookup = {};
        var billPaymentArray = [];
        var inputErrors = [];

        failedRefs.forEach(function (ref) {
            var failed = failedLookup[ref];
            var tran = tranLookup[ref];

            if (!tran) {
                inputErrors.push(ref + ' not found');
                log.error('ACH Return Payment Not Found', {
                    paymentRef: ref,
                    amount: failed.returnedAmount,
                    daysBack: DAYS_BACK
                });
                return;
            }

            if (tran.multiple) {
                inputErrors.push(ref + ' multiple matches');
                log.error('ACH Return Payment Multiple Matches', {
                    paymentRef: ref,
                    matches: tran.matches
                });
                return;
            }

            var paymentRecord = record.load({
                type: tran.processType === PROCESS_CUSTOMER ? record.Type.CUSTOMER_PAYMENT : record.Type.VENDOR_PAYMENT,
                id: tran.paymentId,
                isDynamic: false
            });
            var paymentAmount = money(paymentRecord.getValue({
                fieldId: tran.processType === PROCESS_CUSTOMER ? 'payment' : 'total'
            }));
            if (Math.abs(paymentAmount - failed.returnedAmount) > 0.009) {
                inputErrors.push(ref + ' amount mismatch: CSV ' + failed.returnedAmount + ', payment ' + paymentAmount);
                return;
            }

            if (tran.processType === PROCESS_CUSTOMER) {
                failed.paymentRef = tran.tranId || ref;
                failed.csvPaymentRef = ref;
                failed.paymentId = tran.paymentId;
                customerFailedLookup[failed.paymentRef] = failed;
            } else if (tran.processType === PROCESS_BILL) {
                billPaymentArray.push({
                    processType: PROCESS_BILL,
                    fileId: String(fileObj.id),
                    fileName: fileObj.name,
                    paymentId: tran.paymentId,
                    paymentRef: tran.tranId || ref,
                    csvPaymentRef: ref,
                    returnedAmount: failed.returnedAmount,
                    returnCode: failed.returnCode,
                    returnReason: failed.returnReason
                });
            }
        });

        if (inputErrors.length) {
            throw new Error('ACH Return input has unresolved payment refs: ' + inputErrors.slice(0, 25).join('; '));
        }

        var customerPaymentArray = buildCustomerPaymentGroups(customerFailedLookup, fileObj.id, fileObj.name);
        var familyDimensions = {};
        customerPaymentArray.forEach(function (group) {
            var familyKey = [group.customerId, group.currencyId, group.subsidiaryId, group.arAccountId].join('_');
            if (familyDimensions[familyKey]) {
                throw new Error('Multiple returned groups share the same customer family and accounting dimensions: ' +
                    familyDimensions[familyKey] + ' and ' + group.key + '. Open invoices cannot be allocated independently.');
            }
            familyDimensions[familyKey] = group.key;
        });
        var output = customerPaymentArray.concat(billPaymentArray);

        log.audit('ACH Return Input Prepared', {
            customerGroups: customerPaymentArray.length,
            billPayments: billPaymentArray.length,
            totalMapItems: output.length
        });

        return output.map(function (item) {
            return JSON.stringify(item);
        });
    }

    function map(context) {
        var data = JSON.parse(context.value);

        if (data.processType === PROCESS_CUSTOMER) {
            context.write({ key: data.key, value: context.value });
            return;
        }

        if (data.processType === PROCESS_BILL) {
            var result = createBillPaymentJeAndApply(data.paymentId, data.returnedAmount, data.paymentRef);

            log.audit('Bill Payment Return Processed', {
                paymentId: data.paymentId,
                paymentRef: data.paymentRef,
                csvPaymentRef: data.csvPaymentRef,
                returnedAmount: data.returnedAmount,
                journalId: result.journalId,
                savedPaymentId: result.paymentId
            });

            context.write({ key: 'fileId', value: data.fileId });
            return;
        }

        throw new Error('Unknown process type: ' + data.processType);
    }

    function reduce(context) {
        if (context.key === 'fileId') {
            context.values.forEach(function (fileId) {
                context.write({ key: 'fileId', value: fileId });
            });
            return;
        }

        if (context.values.length !== 1) throw new Error('Customer group ' + context.key + ' appeared more than once.');
        var group = JSON.parse(context.values[0]);
        if (group.processType !== PROCESS_CUSTOMER || group.key !== context.key) {
            throw new Error('Invalid customer group for reduce key ' + context.key);
        }
        processCustomerPaymentGroup(group);
        context.write({ key: 'fileId', value: group.fileId });
    }

    function summarize(summary) {
        var hasErrors = false;
        var fileIds = {};

        if (summary.inputSummary.error) {
            hasErrors = true;
            log.error('ACH Return Input Error', summary.inputSummary.error);
        }

        summary.mapSummary.errors.iterator().each(function (key, errorText) {
            hasErrors = true;
            log.error('ACH Return Map Error', key + ': ' + errorText);
            return true;
        });

        summary.reduceSummary.errors.iterator().each(function (key, errorText) {
            hasErrors = true;
            log.error('ACH Return Reduce Error', key + ': ' + errorText);
            return true;
        });

        summary.output.iterator().each(function (key, value) {
            if (value) fileIds[value] = true;
            return true;
        });

        if (hasErrors) {
            log.audit('ACH Return Complete With Errors', {
                filesTouched: Object.keys(fileIds)
            });
            return;
        }

        Object.keys(fileIds).forEach(function (fileId) {
            var fileObj = file.load({ id: fileId });

            fileObj.description = 'Completed';
            fileObj.folder = PROCESSED_FOLDER_ID;
            fileObj.save();

            log.audit('ACH Return File Completed', {
                fileId: fileId,
                movedToFolder: PROCESSED_FOLDER_ID
            });
        });
    }

    function getReturnFile() {
        var fileId = runtime.getCurrentScript().getParameter({ name: FILE_ID_PARAM });

        if (fileId) return file.load({ id: fileId });

        var latest = search.create({
            type: 'file',
            filters: [
                ['folder', 'anyof', RETURN_FOLDER_ID],
                'AND',
                ['filetype', 'anyof', 'CSV']
            ],
            columns: [
                search.createColumn({ name: 'created', sort: search.Sort.DESC }),
                'internalid',
                'name'
            ]
        }).run().getRange({ start: 0, end: 1 })[0];

        if (!latest) {
            log.audit('ACH Return', 'No CSV file found in folder ' + RETURN_FOLDER_ID);
            return null;
        }

        return file.load({ id: latest.getValue({ name: 'internalid' }) });
    }

    function getReturnedPayments(rows, fileId, fileName) {
        var paymentMap = {};

        rows.forEach(function (row, index) {
            var returnDesc = String(row['Return Type Desc'] || row.cols[7] || '').trim();
            var returnedAmount = money(row['Debit Amount']) ||
                money(row['Returned Amount']) ||
                money(row['Credit Amount']) ||
                money(row['Original Amount']) ||
                money(row.cols[10]) ||
                money(row.cols[35]);

            if (returnDesc && returnDesc.toLowerCase() !== 'return') return;
            if (returnedAmount <= 0) return;

            var paymentRef = getPaymentReference(row, rows[index + 1]);

            if (!paymentRef) {
                log.error('ACH Return Reference Missing', {
                    fileId: fileId,
                    fileName: fileName,
                    row: row.rowNumber,
                    amount: returnedAmount
                });
                throw new Error('ACH Return payment reference missing on CSV row ' + row.rowNumber);
            }

            if (!paymentMap[paymentRef]) {
                paymentMap[paymentRef] = {
                    fileId: String(fileId),
                    fileName: fileName,
                    paymentRef: paymentRef,
                    returnedAmount: 0,
                    returnCode: String(row['Return Reason Code'] || row['Local Return Code'] || row.cols[20] || '').trim(),
                    returnReason: String(row['Return Reason Description'] || row['Local Return Reason'] || row.cols[21] || '').trim()
                };
            }

            paymentMap[paymentRef].returnedAmount = round(paymentMap[paymentRef].returnedAmount + returnedAmount);
        });

        log.debug('ACH Return Failed Payments Parsed', {
            refs: Object.keys(paymentMap).length,
            sampleRefs: Object.keys(paymentMap).slice(0, 25)
        });

        return paymentMap;
    }

    function getPaymentReference(row, nextRow) {
        var recipientId = clean(row['Recipient ID'] || row.cols[11]);
        var alternateId = clean(row.cols[12]);
        var addenda = clean(row['Addenda'] || row.cols[25]);
        var nextRecipientId = nextRow ? clean(nextRow['Recipient ID'] || nextRow.cols[11]) : '';
        var nextAddenda = nextRow ? clean(nextRow['Addenda'] || nextRow.cols[25]) : '';
        var match = null;

        if (!nextRecipientId && nextAddenda) match = nextAddenda.match(/TRANSACTION REFERENCE:\s*([^\s,]+)/i);
        if (!match && addenda) match = addenda.match(/TRANSACTION REFERENCE:\s*([^\s,]+)/i);
        if (match) return clean(match[1]);
        if (/CUSTOMER REFERENCE:/i.test(addenda)) return '';
        if (recipientId) return recipientId;
        return alternateId;
    }

    function findReturnedTransactions(failedLookup) {
        var tranLookup = {};

        runPaged(search.create({
            type: 'transaction',
            settings: [{ name: 'consolidationtype', value: 'ACCTTYPE' }],
            filters: [
                ['type', 'anyof', 'CustPymt', 'VendPymt'],
                'AND',
                ['mainline', 'is', 'T'],
                'AND',
                ['trandate', 'within', 'daysago' + DAYS_BACK, 'daysago0']
            ],
            columns: [
                'internalid',
                'tranid',
                'recordtype',
                'type'
            ]
        }), function (result) {
            var tranId = clean(result.getValue({ name: 'tranid' }));

            if (failedLookup[tranId]) {
                addTransactionMatch(tranLookup, tranId, {
                    paymentId: String(result.getValue({ name: 'internalid' })),
                    tranId: tranId,
                    recordType: result.getValue({ name: 'recordtype' }),
                    typeValue: result.getValue({ name: 'type' }),
                    processType: getProcessType(result.getValue({ name: 'recordtype' }), result.getValue({ name: 'type' }))
                });
            }
        });

        Object.keys(failedLookup).forEach(function (ref) {
            if (!tranLookup[ref]) {
                var fallback = findTransactionByReference(ref);

                if (fallback) addTransactionMatch(tranLookup, ref, fallback);
            }
            if (!tranLookup[ref]) {
                var olderCustomerPayment = findTransactionByReference(ref, true);
                if (olderCustomerPayment) addTransactionMatch(tranLookup, ref, olderCustomerPayment);
            }
        });

        log.audit('ACH Return Transactions Identified', {
            failedRefs: Object.keys(failedLookup).length,
            matchedRefs: Object.keys(tranLookup).length
        });

        return tranLookup;
    }

    function findTransactionByReference(paymentRef, historicalCustomerOnly) {
        var results = search.create({
            type: 'transaction',
            settings: [{ name: 'consolidationtype', value: 'ACCTTYPE' }],
            filters: [
                ['type', 'anyof'].concat(historicalCustomerOnly ? ['CustPymt'] : ['CustPymt', 'VendPymt']),
                'AND',
                ['mainline', 'is', 'T'],
                ...(historicalCustomerOnly ? [] : ['AND', ['trandate', 'within', 'daysago' + DAYS_BACK, 'daysago0']]),
                'AND',
                [
                    ['numbertext', 'is', paymentRef],
                    'OR',
                    ['tranid', 'is', paymentRef]
                ]
            ],
            columns: [
                'internalid',
                'tranid',
                'recordtype',
                'type'
            ]
        }).run().getRange({ start: 0, end: 3 });

        if (!results || !results.length) return null;

        if (results.length > 1) {
            return {
                multiple: true,
                matches: results.map(function (result) {
                    return {
                        paymentId: result.getValue({ name: 'internalid' }),
                        tranId: result.getValue({ name: 'tranid' }),
                        recordType: result.getValue({ name: 'recordtype' })
                    };
                })
            };
        }

        return {
            paymentId: String(results[0].getValue({ name: 'internalid' })),
            tranId: clean(results[0].getValue({ name: 'tranid' })) || paymentRef,
            recordType: results[0].getValue({ name: 'recordtype' }),
            typeValue: results[0].getValue({ name: 'type' }),
            processType: getProcessType(results[0].getValue({ name: 'recordtype' }), results[0].getValue({ name: 'type' }))
        };
    }

    function addTransactionMatch(tranLookup, ref, tran) {
        if (!tran) return;

        if (tran.multiple) {
            tranLookup[ref] = tran;
            return;
        }

        if (!tran.processType) return;

        if (tranLookup[ref] && tranLookup[ref].paymentId !== tran.paymentId) {
            var existing = tranLookup[ref];

            tranLookup[ref] = {
                multiple: true,
                matches: [
                    {
                        paymentId: existing.paymentId,
                        tranId: existing.tranId,
                        recordType: existing.recordType
                    },
                    {
                        paymentId: tran.paymentId,
                        tranId: tran.tranId,
                        recordType: tran.recordType
                    }
                ]
            };
            return;
        }

        tranLookup[ref] = tran;
    }

    function getProcessType(recordType, typeValue) {
        var recordTypeText = String(recordType || '').toLowerCase();
        var typeText = String(typeValue || '');

        if (recordTypeText === 'customerpayment' || typeText === 'CustPymt') return PROCESS_CUSTOMER;
        if (recordTypeText === 'vendorpayment' || typeText === 'VendPymt') return PROCESS_BILL;
        return '';
    }

    function buildCustomerPaymentGroups(customerFailedLookup, fileId, fileName) {
        var failedRefs = Object.keys(customerFailedLookup);
        if (!failedRefs.length) return [];

        var batchIds = {};
        var roots = {};
        var targetKeys = {};
        failedRefs.forEach(function (ref) {
            var payment = record.load({
                type: record.Type.CUSTOMER_PAYMENT,
                id: customerFailedLookup[ref].paymentId,
                isDynamic: false
            });
            var batchId = payment.getValue({ fieldId: BATCH_FIELD });
            if (!batchId) throw new Error('Failed Customer Payment ' + customerFailedLookup[ref].paymentId + ' has no PFA record.');
            batchIds[String(batchId)] = true;
            var customerId = String(payment.getValue({ fieldId: 'customer' }) || payment.getValue({ fieldId: 'entity' }) || '');
            var key = [batchId, getRootCustomerId(customerId, roots),
                payment.getValue({ fieldId: 'account' }), payment.getValue({ fieldId: 'currency' }),
                payment.getValue({ fieldId: 'subsidiary' }), payment.getValue({ fieldId: 'aracct' })].join('_');
            targetKeys[key] = true;
        });

        var groups = {};
        var foundFailedRefs = {};
        runPaged(search.create({
            type: 'customerpayment',
            settings: [{ name: 'consolidationtype', value: 'ACCTTYPE' }],
            filters: [
                ['type', 'anyof', 'CustPymt'], 'AND',
                [BATCH_FIELD, 'anyof', Object.keys(batchIds)], 'AND',
                ['mainline', 'is', 'T']
            ],
            columns: ['internalid', 'tranid', 'trandate', BATCH_FIELD, 'entity']
        }), function (result) {
            var paymentId = String(result.getValue({ name: 'internalid' }) || '');
            var ref = clean(result.getValue({ name: 'tranid' }));
            var batchId = String(result.getValue({ name: BATCH_FIELD }) || '');
            var customerId = String(result.getValue({ name: 'entity' }) || '');
            if (!paymentId || !batchId || !customerId) return;

            var paymentRecord = record.load({ type: record.Type.CUSTOMER_PAYMENT, id: paymentId, isDynamic: false });
            var bankId = String(paymentRecord.getValue({ fieldId: 'account' }) || '');
            var currencyId = String(paymentRecord.getValue({ fieldId: 'currency' }) || '');
            var subsidiaryId = String(paymentRecord.getValue({ fieldId: 'subsidiary' }) || '');
            var arAccountId = String(paymentRecord.getValue({ fieldId: 'aracct' }) || '');
            var amount = money(paymentRecord.getValue({ fieldId: 'payment' }));
            if (!bankId || !currencyId || !subsidiaryId || !arAccountId || !amount) {
                throw new Error('Missing bank, currency, subsidiary, A/R account, or amount on payment ' + paymentId);
            }

            var rootId = getRootCustomerId(customerId, roots);
            var key = [batchId, rootId, bankId, currencyId, subsidiaryId, arAccountId].join('_');
            if (!targetKeys[key]) return;
            var memo = String(paymentRecord.getValue({ fieldId: 'memo' }) || '');
            if (memo.indexOf(NEW_PAYMENT_MEMO_TEXT) !== -1 || memo.indexOf(VOID_MEMO_TEXT) !== -1) {
                throw new Error('PFA ' + batchId + ' has a previously reallocated payment ' + paymentId + '. Review before rerunning.');
            }
            if (!groups[key]) {
                groups[key] = {
                    processType: PROCESS_CUSTOMER,
                    fileId: String(fileId),
                    fileName: fileName,
                    key: key,
                    batchId: batchId,
                    customerId: rootId,
                    accountId: bankId,
                    accountName: String(paymentRecord.getText({ fieldId: 'account' }) || ''),
                    currencyId: currencyId,
                    subsidiaryId: subsidiaryId,
                    arAccountId: arAccountId,
                    payments: [],
                    totals: { batchAmount: 0, failedAmount: 0, availableAmount: 0 },
                    invoiceAmounts: {}
                };
            }

            var failed = customerFailedLookup[ref];
            var appliedInvoices = [];
            var appliedTotal = 0;
            var lineCount = paymentRecord.getLineCount({ sublistId: 'apply' });
            for (var line = 0; line < lineCount; line++) {
                if (!paymentRecord.getSublistValue({ sublistId: 'apply', fieldId: 'apply', line: line })) continue;
                var invoiceId = String(paymentRecord.getSublistValue({ sublistId: 'apply', fieldId: 'doc', line: line }) || '');
                var appliedAmount = money(paymentRecord.getSublistValue({ sublistId: 'apply', fieldId: 'amount', line: line }));
                if (!invoiceId || !appliedAmount) throw new Error('Invalid apply line on payment ' + paymentId);
                appliedInvoices.push({ invoiceId: invoiceId, appliedAmount: appliedAmount });
                appliedTotal = round(appliedTotal + appliedAmount);
                groups[key].invoiceAmounts[invoiceId] = round((groups[key].invoiceAmounts[invoiceId] || 0) + appliedAmount);
            }
            if (Math.abs(amount - appliedTotal) > 0.009) {
                throw new Error('Payment ' + paymentId + ' has ' + appliedTotal + ' applied, but its header amount is ' + amount);
            }

            groups[key].payments.push({
                paymentId: paymentId,
                paymentRef: ref,
                paymentDate: result.getValue({ name: 'trandate' }),
                customerId: customerId,
                amount: amount,
                failed: !!failed,
                appliedInvoices: appliedInvoices
            });
            groups[key].totals.batchAmount = round(groups[key].totals.batchAmount + amount);
            if (failed) {
                foundFailedRefs[failed.csvPaymentRef || ref] = true;
                groups[key].totals.failedAmount = round(groups[key].totals.failedAmount + failed.returnedAmount);
            }
        });

        var output = Object.keys(groups).filter(function (key) {
            return groups[key].totals.failedAmount > 0;
        }).map(function (key) {
            var group = groups[key];
            group.totals.availableAmount = round(group.totals.batchAmount - group.totals.failedAmount);
            if (group.totals.availableAmount < 0) throw new Error('Returns exceed payment total in group ' + key);
            prepareCustomerAllocation(group);
            return group;
        });

        var unmatched = failedRefs.filter(function (ref) {
            return !foundFailedRefs[customerFailedLookup[ref].csvPaymentRef || ref];
        });
        if (unmatched.length) throw new Error('Failed customer payments missing from PFA search: ' + unmatched.join(', '));

        log.audit('Customer Return Groups Built', {
            groups: output.length,
            payments: output.reduce(function (n, group) { return n + group.payments.length; }, 0)
        });
        return output;
    }

    function getRootCustomerId(customerId, cache) {
        var current = String(customerId);
        if (cache[current]) return cache[current];
        var parentId = String(record.load({ type: record.Type.CUSTOMER, id: current, isDynamic: false })
            .getValue({ fieldId: 'parent' }) || '');
        if (parentId === current) throw new Error('Customer ' + current + ' is its own parent.');
        var root = parentId || current;
        cache[current] = root;
        return root;
    }

    function getCustomerFamilyIds(rootId) {
        var ids = [String(rootId)];
        runPaged(search.create({
            type: search.Type.CUSTOMER,
            filters: [['parent', 'anyof', rootId]],
            columns: [search.createColumn({ name: 'internalid', sort: search.Sort.ASC })]
        }), function (result) {
            var id = String(result.getValue({ name: 'internalid' }));
            if (ids.indexOf(id) === -1) ids.push(id);
        });
        log.debug('Customer Family Discovered', { rootCustomerId: rootId, customerIds: ids });
        return ids;
    }

    function prepareCustomerAllocation(group) {
        var accountName = String(group.accountName || '');
        var itemSeqField = OPERATING_SEQ_FIELD;
        var invoiceAmounts = group.invoiceAmounts || {};
        var originalIds = Object.keys(invoiceAmounts);
        var invoiceInfo = {};
        var familyIds = getCustomerFamilyIds(group.customerId);

        if (accountName.indexOf('- NAF - USD -') !== -1 || accountName.indexOf('- NAF - CAD -') !== -1) {
            itemSeqField = NAF_SEQ_FIELD;
        }

        function collectInvoice(result) {
            var invoiceId = String(result.getValue({ name: 'internalid' }));
            if (invoiceInfo[invoiceId]) return;
            var invoiceRecord = record.load({ type: record.Type.INVOICE, id: invoiceId, isDynamic: false });
            var customerId = String(invoiceRecord.getValue({ fieldId: 'entity' }) || '');
            var currencyId = String(invoiceRecord.getValue({ fieldId: 'currency' }) || '');
            var subsidiaryId = String(invoiceRecord.getValue({ fieldId: 'subsidiary' }) || '');
            var arAccountId = String(invoiceRecord.getValue({ fieldId: 'account' }) || '');
            var remainingAmount = money(invoiceRecord.getValue({ fieldId: 'amountremaining' }));

            if (familyIds.indexOf(customerId) === -1) {
                throw new Error('Invoice ' + invoiceId + ' is outside customer family ' + group.customerId);
            }
            if (currencyId !== group.currencyId || subsidiaryId !== group.subsidiaryId || arAccountId !== group.arAccountId) {
                if (invoiceAmounts[invoiceId] !== undefined) {
                    throw new Error('Applied invoice ' + invoiceId + ' has different currency, subsidiary, or A/R account from group ' + group.key);
                }
                return;
            }

            invoiceInfo[invoiceId] = {
                invoiceId: invoiceId,
                customerId: customerId,
                invoiceNumber: result.getValue({ name: 'tranid' }),
                invoiceDate: result.getValue({ name: 'trandate' }),
                invoiceDateTime: dateTime(result.getValue({ name: 'trandate' })),
                itemSequence: 999999999,
                currentAmount: round((invoiceAmounts[invoiceId] || 0) + remainingAmount),
                originallyApplied: invoiceAmounts[invoiceId] || 0
            };
        }

        var invoiceColumns = [search.createColumn({ name: 'internalid', sort: search.Sort.ASC }),
            'tranid', 'trandate'];

        if (originalIds.length) {
            runPaged(search.create({
                type: search.Type.INVOICE,
                filters: [['internalid', 'anyof', originalIds], 'AND', ['mainline', 'is', 'T']],
                columns: invoiceColumns
            }), collectInvoice);
        }

        runPaged(search.create({
            type: search.Type.INVOICE,
            filters: [
                ['entity', 'anyof', familyIds], 'AND',
                ['mainline', 'is', 'T'], 'AND',
                ['amountremaining', 'greaterthan', '0']
            ],
            columns: invoiceColumns
        }), collectInvoice);

        originalIds.forEach(function (invoiceId) {
            if (!invoiceInfo[invoiceId]) throw new Error('Applied invoice ' + invoiceId + ' could not be read for group ' + group.key);
        });

        var invoiceIds = Object.keys(invoiceInfo);
        if (invoiceIds.length) {
            runPaged(search.create({
                type: search.Type.INVOICE,
                filters: [
                    ['internalid', 'anyof', invoiceIds],
                    'AND',
                    ['mainline', 'is', 'F'],
                    'AND',
                    ['taxline', 'is', 'F'],
                    'AND',
                    ['shipping', 'is', 'F'],
                    'AND',
                    ['cogs', 'is', 'F']
                ],
                columns: [
                    'internalid',
                    'tranid',
                    'trandate',
                    search.createColumn({ name: itemSeqField, join: 'item' })
                ]
            }), function (result) {
                var invoiceId = String(result.getValue({ name: 'internalid' }));
                var seqText = result.getValue({ name: itemSeqField, join: 'item' });
                var seq = Number(String(seqText || '').replace(/,/g, ''));

                if (seqText === '' || seqText === null || isNaN(seq)) seq = 999999999;

                if (invoiceInfo[invoiceId] && seq < invoiceInfo[invoiceId].itemSequence) {
                    invoiceInfo[invoiceId].itemSequence = seq;
                }
            });
        }

        invoiceIds.sort(function (a, b) {
            return invoiceInfo[a].invoiceDateTime - invoiceInfo[b].invoiceDateTime ||
                invoiceInfo[a].itemSequence - invoiceInfo[b].itemSequence ||
                Number(a) - Number(b);
        });

        var remaining = group.totals.availableAmount;
        var desiredByInvoice = {};
        var allocation = { full: 0, partial: 0, unpaid: 0 };
        var details = [];

        invoiceIds.forEach(function (invoiceId) {
            var currentAmount = invoiceInfo[invoiceId].currentAmount;
            var desiredAmount = round(Math.min(currentAmount, remaining));

            desiredByInvoice[invoiceId] = desiredAmount;
            remaining = round(remaining - desiredAmount);

            if (desiredAmount >= currentAmount - 0.009) allocation.full++;
            else if (desiredAmount > 0) allocation.partial++;
            else allocation.unpaid++;

            details.push({
                invoiceId: invoiceId,
                customerId: invoiceInfo[invoiceId].customerId,
                invoiceNumber: invoiceInfo[invoiceId].invoiceNumber,
                invoiceDate: invoiceInfo[invoiceId].invoiceDate,
                itemSequence: invoiceInfo[invoiceId].itemSequence,
                currentAmount: currentAmount,
                originallyApplied: invoiceInfo[invoiceId].originallyApplied,
                desiredAmount: desiredAmount
            });
        });

        group.itemSeqField = itemSeqField;
        group.familyIds = familyIds;
        group.invoiceInfo = invoiceInfo;
        group.desiredByInvoice = desiredByInvoice;
        group.allocation = allocation;
        group.allocationDetails = details;

        log.audit('Customer Allocation Prepared', {
            key: group.key,
            itemSeqField: itemSeqField,
            invoices: invoiceIds.length,
            full: allocation.full,
            partial: allocation.partial,
            unpaid: allocation.unpaid,
            unusedAmount: remaining
        });
        log.debug('Customer Allocation Detail', {
            key: group.key,
            detailsShown: Math.min(details.length, 25),
            details: details.slice(0, 25)
        });
    }

    function processCustomerPaymentGroup(group) {
        var payments = group.payments.sort(function (a, b) {
            return dateTime(a.paymentDate) - dateTime(b.paymentDate) ||
                String(a.paymentRef).localeCompare(String(b.paymentRef)) ||
                Number(a.paymentId) - Number(b.paymentId);
        });
        var sourceRecords = {};
        var expectedTotal = 0;
        var desiredTotal = 0;

        payments.forEach(function (payment) {
            var paymentRecord = record.load({
                type: record.Type.CUSTOMER_PAYMENT,
                id: payment.paymentId,
                isDynamic: false
            });
            var expected = {};
            payment.appliedInvoices.forEach(function (entry) {
                expected[entry.invoiceId] = round((expected[entry.invoiceId] || 0) + entry.appliedAmount);
            });
            if (String(paymentRecord.getValue({ fieldId: BATCH_FIELD }) || '') !== String(group.batchId) ||
                String(paymentRecord.getValue({ fieldId: 'account' }) || '') !== String(group.accountId) ||
                Math.abs(money(paymentRecord.getValue({ fieldId: 'payment' })) - payment.amount) > 0.009) {
                throw new Error('Customer Payment ' + payment.paymentId + ' changed after input preparation.');
            }
            for (var line = 0; line < paymentRecord.getLineCount({ sublistId: 'apply' }); line++) {
                if (!paymentRecord.getSublistValue({ sublistId: 'apply', fieldId: 'apply', line: line })) continue;
                var docId = String(paymentRecord.getSublistValue({ sublistId: 'apply', fieldId: 'doc', line: line }) || '');
                var amount = money(paymentRecord.getSublistValue({ sublistId: 'apply', fieldId: 'amount', line: line }));
                if (!expected[docId] || Math.abs(expected[docId] - amount) > 0.009) {
                    throw new Error('Customer Payment ' + payment.paymentId + ' applications changed after input preparation.');
                }
                delete expected[docId];
            }
            if (Object.keys(expected).length) throw new Error('Customer Payment ' + payment.paymentId + ' is missing invoice applications.');
            sourceRecords[payment.paymentId] = paymentRecord;
            expectedTotal = round(expectedTotal + payment.amount);
        });

        Object.keys(group.desiredByInvoice).forEach(function (invoiceId) {
            desiredTotal = round(desiredTotal + group.desiredByInvoice[invoiceId]);
        });
        if (Math.abs(expectedTotal - group.totals.batchAmount) > 0.009 ||
            desiredTotal > group.totals.availableAmount + 0.009 ||
            Math.abs(round(expectedTotal - group.totals.availableAmount) - group.totals.failedAmount) > 0.009) {
            throw new Error('Customer group ' + group.key + ' does not reconcile before edits.');
        }
        var estimatedUsage = payments.length * 75 +
            payments.reduce(function (n, payment) { return n + payment.appliedInvoices.length; }, 0) * 90 + 100;
        if (estimatedUsage > runtime.getCurrentScript().getRemainingUsage()) {
            throw new Error('Customer group ' + group.key + ' may exceed map usage. Estimated ' + estimatedUsage +
                ', remaining ' + runtime.getCurrentScript().getRemainingUsage());
        }

        log.audit('Customer Group Start', {
            key: group.key,
            payments: payments.length,
            failedPayments: payments.filter(function (payment) { return payment.failed; }).length,
            invoiceJes: payments.reduce(function (n, payment) { return n + payment.appliedInvoices.length; }, 0),
            batchAmount: expectedTotal,
            failedAmount: group.totals.failedAmount,
            masterAmount: group.totals.availableAmount,
            allocation: group.allocation
        });

        var jeTotal = 0;
        payments.forEach(function (payment) {
            var removed = payment.appliedInvoices.map(function (entry) {
                return { invoiceId: entry.invoiceId, amount: entry.appliedAmount };
            });
            var journals = createCustomerPaymentJes(payment.paymentId, removed, payment.paymentRef, sourceRecords[payment.paymentId]);
            var journalById = {};
            var originalById = {};
            journals.forEach(function (entry) { journalById[String(entry.journalId)] = entry; });
            removed.forEach(function (entry) { originalById[entry.invoiceId] = entry; });

            var edit = record.load({
                type: record.Type.CUSTOMER_PAYMENT,
                id: payment.paymentId,
                isDynamic: false
            });
            for (var line = 0; line < edit.getLineCount({ sublistId: 'apply' }); line++) {
                var docId = String(edit.getSublistValue({ sublistId: 'apply', fieldId: 'doc', line: line }) || '');
                var internalId = String(edit.getSublistValue({ sublistId: 'apply', fieldId: 'internalid', line: line }) || '');
                if (originalById[docId]) {
                    edit.setSublistValue({ sublistId: 'apply', fieldId: 'apply', line: line, value: false });
                    delete originalById[docId];
                }
                var journal = journalById[docId] || journalById[internalId];
                if (journal) {
                    edit.setSublistValue({ sublistId: 'apply', fieldId: 'apply', line: line, value: true });
                    edit.setSublistValue({ sublistId: 'apply', fieldId: 'amount', line: line, value: journal.amount });
                    delete journalById[String(journal.journalId)];
                }
            }
            if (Object.keys(originalById).length || Object.keys(journalById).length) {
                throw new Error('Payment ' + payment.paymentId + ' is missing invoice or JE lines; created JEs: ' +
                    journals.map(function (entry) { return entry.journalId; }).join(', '));
            }
            var memo = String(edit.getValue({ fieldId: 'memo' }) || '');
            edit.setValue({ fieldId: 'memo', value: memo ? memo + ' | ' + VOID_MEMO_TEXT : VOID_MEMO_TEXT });
            var savedId = edit.save({ enableSourcing: false, ignoreMandatoryFields: true });
            jeTotal = round(jeTotal + payment.amount);
            log.audit('Customer Payment Offset', {
                paymentId: savedId,
                paymentRef: payment.paymentRef,
                amount: payment.amount,
                invoiceJes: journals
            });
        });

        var masterPaymentId = null;
        if (group.totals.availableAmount > 0.009) {
            masterPaymentId = createMasterPayment(group, payments[0]);
        }
        log.audit('Customer Group Complete', {
            key: group.key,
            offsetAmount: jeTotal,
            failedAmount: group.totals.failedAmount,
            masterPaymentId: masterPaymentId,
            masterAmount: group.totals.availableAmount,
            appliedToInvoices: desiredTotal,
            unappliedAmount: round(group.totals.availableAmount - desiredTotal)
        });
    }

    function createMasterPayment(group, sourcePayment) {
        var paymentRecord = record.transform({
            fromType: record.Type.CUSTOMER,
            fromId: group.customerId,
            toType: record.Type.CUSTOMER_PAYMENT,
            isDynamic: true
        });
        var date = new Date(dateTime(sourcePayment.paymentDate));
        if (isNaN(date.getTime())) throw new Error('Invalid source payment date for ' + sourcePayment.paymentId);

        paymentRecord.setValue({ fieldId: 'subsidiary', value: group.subsidiaryId });
        paymentRecord.setValue({ fieldId: 'currency', value: group.currencyId });
        paymentRecord.setValue({ fieldId: 'aracct', value: group.arAccountId });
        paymentRecord.setValue({ fieldId: 'undepfunds', value: false });
        paymentRecord.setValue({ fieldId: 'account', value: group.accountId });
        paymentRecord.setValue({ fieldId: 'trandate', value: date });
        paymentRecord.setValue({ fieldId: BATCH_FIELD, value: group.batchId });
        paymentRecord.setValue({ fieldId: 'autoapply', value: false });
        paymentRecord.setValue({ fieldId: 'payment', value: group.totals.availableAmount });
        paymentRecord.setValue({ fieldId: 'memo', value: NEW_PAYMENT_MEMO_TEXT + ' | PFA ' + group.batchId +
            ' | Source Payment ' + sourcePayment.paymentId });

        var needed = {};
        Object.keys(group.desiredByInvoice).forEach(function (invoiceId) {
            if (group.desiredByInvoice[invoiceId] > 0.009) needed[invoiceId] = group.desiredByInvoice[invoiceId];
        });
        var applyLineCount = paymentRecord.getLineCount({ sublistId: 'apply' });
        log.debug('Master Payment Apply Lines', {
            key: group.key,
            parentCustomerId: group.customerId,
            arAccountId: group.arAccountId,
            applyLineCount: applyLineCount,
            neededInvoiceIds: Object.keys(needed)
        });
        for (var i = 0; i < applyLineCount; i++) {
            var invoiceId = String(paymentRecord.getSublistValue({ sublistId: 'apply', fieldId: 'doc', line: i }) || '');
            var amount = needed[invoiceId];
            if (!amount) {
                if (paymentRecord.getSublistValue({ sublistId: 'apply', fieldId: 'apply', line: i })) {
                    paymentRecord.selectLine({ sublistId: 'apply', line: i });
                    paymentRecord.setCurrentSublistValue({ sublistId: 'apply', fieldId: 'apply', value: false });
                    paymentRecord.commitLine({ sublistId: 'apply' });
                }
                continue;
            }
            paymentRecord.selectLine({ sublistId: 'apply', line: i });
            paymentRecord.setCurrentSublistValue({ sublistId: 'apply', fieldId: 'apply', value: true });
            paymentRecord.setCurrentSublistValue({ sublistId: 'apply', fieldId: 'amount', value: amount });
            paymentRecord.commitLine({ sublistId: 'apply' });
            delete needed[invoiceId];
        }
        if (Object.keys(needed).length) {
            throw new Error('Parent Customer Payment cannot see eligible invoices: ' + Object.keys(needed).join(', ') +
                ' (parent ' + group.customerId + ', A/R ' + group.arAccountId + ', apply lines ' + applyLineCount + ')');
        }
        var paymentId = paymentRecord.save({ enableSourcing: false, ignoreMandatoryFields: false });
        log.audit('Master Customer Payment Created', {
            key: group.key,
            paymentId: paymentId,
            parentCustomerId: group.customerId,
            amount: group.totals.availableAmount,
            invoiceAllocation: group.allocationDetails.filter(function (entry) { return entry.desiredAmount > 0.009; })
        });
        return paymentId;
    }

    function createCustomerPaymentJes(paymentId, removed, paymentRef, paymentHeader) {
        var customerId = paymentHeader.getValue({ fieldId: 'customer' }) || paymentHeader.getValue({ fieldId: 'entity' });
        var subsidiaryId = paymentHeader.getValue({ fieldId: 'subsidiary' });
        var currencyId = paymentHeader.getValue({ fieldId: 'currency' });
        var mainInfo = {};
        var lineMap = {};
        var sourceLines = [];
        var sourceDebitTotal = 0;
        var sourceCreditTotal = 0;
        var memoText = CUSTOMER_JE_MEMO_TEXT + ' - ' + paymentRef;

        runPaged(search.create({
            type: 'customerpayment',
            settings: [{ name: 'consolidationtype', value: 'ACCTTYPE' }],
            filters: [
                ['type', 'anyof', 'CustPymt'],
                'AND',
                ['internalid', 'anyof', paymentId]
            ],
            columns: [
                'accountmain',
                'account',
                'entity',
                'department',
                'class',
                'location',
                'memo',
                'debitamount',
                'creditamount'
            ]
        }), function (result) {
            var mainAccount = result.getValue({ name: 'accountmain' });
            var lineAccount = result.getValue({ name: 'account' });
            var debitAmount = money(result.getValue({ name: 'debitamount' }));
            var creditAmount = money(result.getValue({ name: 'creditamount' }));
            var entityId = result.getValue({ name: 'entity' }) || customerId;
            var departmentId = result.getValue({ name: 'department' });
            var classId = result.getValue({ name: 'class' });
            var locationId = result.getValue({ name: 'location' });

            if (!lineAccount || (!debitAmount && !creditAmount)) return;

            if (String(mainAccount) === String(lineAccount)) {
                mainInfo = {
                    account: mainAccount,
                    entity: entityId,
                    department: departmentId,
                    classId: classId,
                    location: locationId
                };
                return;
            }

            var side = debitAmount > 0 ? 'C' : 'D';
            var key = [lineAccount, entityId, departmentId || '', classId || '', locationId || '', side].join('|');

            if (!lineMap[key]) {
                lineMap[key] = {
                    account: lineAccount,
                    entity: entityId,
                    department: departmentId,
                    classId: classId,
                    location: locationId,
                    sourceDebit: 0,
                    sourceCredit: 0,
                    debit: 0,
                    credit: 0
                };
                sourceLines.push(lineMap[key]);
            }

            lineMap[key].sourceDebit = round(lineMap[key].sourceDebit + debitAmount);
            lineMap[key].sourceCredit = round(lineMap[key].sourceCredit + creditAmount);
            sourceDebitTotal = round(sourceDebitTotal + debitAmount);
            sourceCreditTotal = round(sourceCreditTotal + creditAmount);
        });

        if (!sourceLines.length) throw new Error('No non-main GL lines found for Customer Payment ' + paymentId);

        log.debug('Customer Payment JE Source Prepared', {
            paymentId: paymentId,
            paymentRef: paymentRef,
            invoices: removed.length,
            mainInfo: mainInfo,
            sourceDebitTotal: sourceDebitTotal,
            sourceCreditTotal: sourceCreditTotal,
            lines: sourceLines
        });

        var journals = removed.map(function (entry) {
            var jeLines = sourceLines.map(function (line) { return Object.assign({}, line); });
            scaleJeLines(jeLines, sourceDebitTotal, sourceCreditTotal, entry.amount);
            balanceJeLines(jeLines, mainInfo);

            var jeRecord = record.create({
                type: record.Type.JOURNAL_ENTRY,
                isDynamic: true
            });

            jeRecord.setValue({ fieldId: 'subsidiary', value: subsidiaryId });
            if (currencyId) jeRecord.setValue({ fieldId: 'currency', value: currencyId });
            jeRecord.setValue({ fieldId: 'approvalstatus', value: 2 });
            jeRecord.setValue({ fieldId: 'memo', value: memoText });
            jeRecord.setValue({ fieldId: JE_INVOICE_FIELD, value: entry.invoiceId });

            jeLines.forEach(function (line) {
                if (!line.account || (!line.debit && !line.credit)) return;

                jeRecord.selectNewLine({ sublistId: 'line' });
                jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'linesubsidiary', value: subsidiaryId });
                jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: line.account });
                jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'entity', value: line.entity || mainInfo.entity || customerId });
                jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'memo', value: memoText });
                if (line.department || mainInfo.department) jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'department', value: line.department || mainInfo.department });
                if (line.classId || mainInfo.classId) jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'class', value: line.classId || mainInfo.classId });
                if (line.location || mainInfo.location) jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'location', value: line.location || mainInfo.location });
                if (line.debit) jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'debit', value: line.debit });
                if (line.credit) jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'credit', value: line.credit });
                jeRecord.commitLine({ sublistId: 'line' });
            });

            var journalId = jeRecord.save();
            log.audit('Customer Invoice Offset JE Created', {
                paymentId: paymentId,
                invoiceId: entry.invoiceId,
                amount: entry.amount,
                journalId: journalId
            });
            return { invoiceId: entry.invoiceId, amount: entry.amount, journalId: journalId };
        });

        return journals;
    }

    function createBillPaymentJeAndApply(paymentId, returnedAmount, paymentRef) {
        var paymentRecord = record.load({
            type: record.Type.VENDOR_PAYMENT,
            id: paymentId,
            isDynamic: false
        });
        var entityId = paymentRecord.getValue({ fieldId: 'entity' });
        var subsidiaryId = paymentRecord.getValue({ fieldId: 'subsidiary' });
        var currencyId = paymentRecord.getValue({ fieldId: 'currency' });
        var mainAccountId = paymentRecord.getValue({ fieldId: 'account' });
        var paymentTotal = round(money(paymentRecord.getValue({ fieldId: 'total' })));
        var jeAmount = round(returnedAmount || paymentTotal);

        if (jeAmount <= 0) throw new Error('JE amount is zero for Bill Payment ' + paymentId);

        var jeLines = getBillPaymentJeLines(paymentId, mainAccountId, entityId, jeAmount);
        var memoText = AP_MEMO_TEXT + ' - ' + paymentRef;
        var jeRecord = record.create({
            type: record.Type.JOURNAL_ENTRY,
            isDynamic: true
        });

        jeRecord.setValue({ fieldId: 'subsidiary', value: subsidiaryId });
        if (currencyId) jeRecord.setValue({ fieldId: 'currency', value: currencyId });
        jeRecord.setValue({ fieldId: 'approvalstatus', value: 2 });
        jeRecord.setValue({ fieldId: 'memo', value: memoText });

        jeLines.forEach(function (line) {
            if (!line.account || (!line.debit && !line.credit)) return;

            jeRecord.selectNewLine({ sublistId: 'line' });
            jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'linesubsidiary', value: subsidiaryId });
            jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: line.account });
            if (line.entity) jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'entity', value: line.entity });
            else jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'entity', value: entityId });
            jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'memo', value: memoText });
            if (line.department) jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'department', value: line.department });
            else jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'department', value: 1 });
            if (line.classId) jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'class', value: line.classId });
            if (line.location) jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'location', value: line.location });
            if (line.debit) jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'debit', value: line.debit });
            if (line.credit) jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'credit', value: line.credit });
            jeRecord.commitLine({ sublistId: 'line' });
        });

        var jeId = jeRecord.save();
        var savedPaymentId = applyBillPaymentToJe(paymentId, jeId, jeAmount);

        log.audit('Bill Payment JE Created', {
            paymentId: paymentId,
            paymentRef: paymentRef,
            paymentTotal: paymentTotal,
            returnedAmount: returnedAmount,
            jeAmount: jeAmount,
            journalId: jeId,
            lines: jeLines
        });

        return {
            journalId: jeId,
            paymentId: savedPaymentId
        };
    }

    function getBillPaymentJeLines(paymentId, mainAccountId, entityId, jeAmount) {
        var mainInfo = { account: mainAccountId, entity: entityId };
        var lineMap = {};
        var jeLines = [];
        var sourceDebitTotal = 0;
        var sourceCreditTotal = 0;

        runPaged(search.create({
            type: 'vendorpayment',
            settings: [{ name: 'consolidationtype', value: 'ACCTTYPE' }],
            filters: [
                ['type', 'anyof', 'VendPymt'],
                'AND',
                ['internalid', 'anyof', paymentId]
            ],
            columns: [
                'accountmain',
                'account',
                'entity',
                'department',
                'class',
                'location',
                'memo',
                'debitfxamount',
                'creditfxamount',
                'debitamount',
                'creditamount'
            ]
        }), function (result) {
            var accountMain = result.getValue({ name: 'accountmain' }) || mainAccountId;
            var lineAccount = result.getValue({ name: 'account' });
            var debitAmount = money(result.getValue({ name: 'debitfxamount' })) ||
                money(result.getValue({ name: 'debitamount' }));
            var creditAmount = money(result.getValue({ name: 'creditfxamount' })) ||
                money(result.getValue({ name: 'creditamount' }));
            var lineEntity = result.getValue({ name: 'entity' }) || entityId;
            var departmentId = result.getValue({ name: 'department' });
            var classId = result.getValue({ name: 'class' });
            var locationId = result.getValue({ name: 'location' });

            if (!lineAccount || (!debitAmount && !creditAmount)) return;

            if (String(accountMain) === String(lineAccount)) {
                mainInfo = {
                    account: accountMain,
                    entity: lineEntity,
                    department: departmentId,
                    classId: classId,
                    location: locationId
                };
                return;
            }

            var side = debitAmount > 0 ? 'C' : 'D';
            var key = [lineAccount, lineEntity, departmentId || '', classId || '', locationId || '', side].join('|');

            if (!lineMap[key]) {
                lineMap[key] = {
                    account: lineAccount,
                    entity: lineEntity,
                    department: departmentId,
                    classId: classId,
                    location: locationId,
                    sourceDebit: 0,
                    sourceCredit: 0,
                    debit: 0,
                    credit: 0
                };
                jeLines.push(lineMap[key]);
            }

            lineMap[key].sourceDebit = round(lineMap[key].sourceDebit + debitAmount);
            lineMap[key].sourceCredit = round(lineMap[key].sourceCredit + creditAmount);
            sourceDebitTotal = round(sourceDebitTotal + debitAmount);
            sourceCreditTotal = round(sourceCreditTotal + creditAmount);
        });

        if (!jeLines.length) throw new Error('No non-main GL lines found for Bill Payment ' + paymentId);

        scaleJeLines(jeLines, sourceDebitTotal, sourceCreditTotal, jeAmount);
        balanceJeLines(jeLines, mainInfo);

        log.debug('Bill Payment JE Lines Prepared', {
            paymentId: paymentId,
            mainAccountId: mainInfo.account,
            jeAmount: jeAmount,
            sourceDebitTotal: sourceDebitTotal,
            sourceCreditTotal: sourceCreditTotal,
            lines: jeLines
        });

        return jeLines;
    }

    function scaleJeLines(jeLines, sourceDebitTotal, sourceCreditTotal, jeAmount) {
        var debitCreated = 0;
        var creditCreated = 0;
        var lastDebitLine = null;
        var lastCreditLine = null;

        jeLines.forEach(function (line) {
            if (line.sourceCredit > 0 && sourceCreditTotal > 0) {
                line.debit = round(line.sourceCredit / sourceCreditTotal * jeAmount);
                debitCreated = round(debitCreated + line.debit);
                lastDebitLine = line;
            }

            if (line.sourceDebit > 0 && sourceDebitTotal > 0) {
                line.credit = round(line.sourceDebit / sourceDebitTotal * jeAmount);
                creditCreated = round(creditCreated + line.credit);
                lastCreditLine = line;
            }
        });

        if (lastDebitLine) lastDebitLine.debit = round(lastDebitLine.debit + jeAmount - debitCreated);
        if (lastCreditLine) lastCreditLine.credit = round(lastCreditLine.credit + jeAmount - creditCreated);
    }

    function balanceJeLines(jeLines, mainInfo) {
        var totalDebit = 0;
        var totalCredit = 0;

        jeLines.forEach(function (line) {
            totalDebit = round(totalDebit + money(line.debit));
            totalCredit = round(totalCredit + money(line.credit));
        });

        if (Math.abs(totalDebit - totalCredit) <= 0.009) return;
        if (!mainInfo.account) throw new Error('Main account missing for balancing line.');

        jeLines.push({
            account: mainInfo.account,
            entity: mainInfo.entity,
            department: mainInfo.department,
            classId: mainInfo.classId,
            location: mainInfo.location,
            debit: totalCredit > totalDebit ? round(totalCredit - totalDebit) : 0,
            credit: totalDebit > totalCredit ? round(totalDebit - totalCredit) : 0
        });
    }

    function applyBillPaymentToJe(paymentId, jeId, jeAmount) {
        var paymentRecord = record.load({
            type: record.Type.VENDOR_PAYMENT,
            id: paymentId,
            isDynamic: false
        });
        var lineCount = paymentRecord.getLineCount({ sublistId: 'apply' });
        var appliedJe = false;

        for (var i = 0; i < lineCount; i++) {
            paymentRecord.setSublistValue({ sublistId: 'apply', fieldId: 'apply', line: i, value: false });
        }

        try {
            paymentRecord.setValue({ fieldId: UNAPPLIED_DATE_FIELD, value: new Date() });
        } catch (e) {
            log.debug('Bill Payment Unapplied Date Not Set', e.message);
        }

        for (var j = 0; j < lineCount; j++) {
            var internalId = String(paymentRecord.getSublistValue({
                sublistId: 'apply',
                fieldId: 'internalid',
                line: j
            }) || '');
            var docId = String(paymentRecord.getSublistValue({
                sublistId: 'apply',
                fieldId: 'doc',
                line: j
            }) || '');

            if (internalId === String(jeId) || docId === String(jeId)) {
                paymentRecord.setSublistValue({ sublistId: 'apply', fieldId: 'apply', line: j, value: true });

                try {
                    paymentRecord.setSublistValue({ sublistId: 'apply', fieldId: 'amount', line: j, value: jeAmount });
                } catch (e2) {
                    log.debug('Bill Payment JE Apply Amount Not Set', e2.message);
                }

                appliedJe = true;
                break;
            }
        }

        if (!appliedJe) {
            throw new Error('Journal Entry ' + jeId + ' was not found on Bill Payment ' + paymentId + ' apply sublist.');
        }

        return paymentRecord.save({ enableSourcing: false, ignoreMandatoryFields: true });
    }

    function isDuplicateFile(fileName) {
        return !!search.create({
            type: 'file',
            filters: [
                ['name', 'is', fileName],
                'AND',
                ['folder', 'anyof', PROCESSED_FOLDER_ID]
            ],
            columns: ['internalid']
        }).run().getRange({ start: 0, end: 1 }).length;
    }

    function runPaged(searchObj, callback) {
        var paged = searchObj.runPaged({ pageSize: 1000 });

        paged.pageRanges.forEach(function (range) {
            paged.fetch({ index: range.index }).data.forEach(callback);
        });
    }

    function parseCsv(text) {
        var rawRows = [];
        var row = [];
        var cell = '';
        var quoted = false;

        for (var i = 0; i < text.length; i++) {
            var c = text.charAt(i);
            var next = text.charAt(i + 1);

            if (c === '"' && quoted && next === '"') {
                cell += '"';
                i++;
            } else if (c === '"') {
                quoted = !quoted;
            } else if (c === ',' && !quoted) {
                row.push(cell);
                cell = '';
            } else if ((c === '\n' || c === '\r') && !quoted) {
                if (c === '\r' && next === '\n') i++;
                row.push(cell);
                if (row.join('').trim()) rawRows.push(row);
                row = [];
                cell = '';
            } else {
                cell += c;
            }
        }

        if (cell || row.length) {
            row.push(cell);
            if (row.join('').trim()) rawRows.push(row);
        }

        var headers = (rawRows.shift() || []).map(function (header) {
            return clean(String(header || '').replace(/^\uFEFF/, ''));
        });

        return rawRows.map(function (cols, index) {
            var obj = {
                cols: cols,
                rowNumber: index + 2
            };

            headers.forEach(function (header, colIndex) {
                obj[header] = cols[colIndex] || '';
            });

            return obj;
        });
    }

    function clean(value) {
        return String(value || '').replace(/^"|"$/g, '').trim();
    }

    function money(value) {
        var match = String(value || '').replace(/[$,]/g, '').match(/-?\d+(\.\d+)?/);
        return match ? Math.abs(Number(match[0])) : 0;
    }

    function round(value) {
        return Math.round((Number(value) || 0) * 100) / 100;
    }

    function dateTime(value) {
        try {
            return format.parse({ value: value, type: format.Type.DATE }).getTime();
        } catch (e) {
            var time = new Date(value).getTime();
            return isNaN(time) ? 9999999999999 : time;
        }
    }

    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce,
        summarize: summarize
    };
});
