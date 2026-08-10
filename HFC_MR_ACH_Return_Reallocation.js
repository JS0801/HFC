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
        var billFailedLookup = {};
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

            if (tran.processType === PROCESS_CUSTOMER) {
                failed.paymentRef = tran.tranId || ref;
                failed.csvPaymentRef = ref;
                customerFailedLookup[failed.paymentRef] = failed;
            } else if (tran.processType === PROCESS_BILL) {
                failed.paymentId = tran.paymentId;
                failed.paymentRef = tran.tranId || ref;
                failed.csvPaymentRef = ref;
                billFailedLookup[failed.paymentRef] = failed;
            }
        });

        if (inputErrors.length) {
            throw new Error('ACH Return input has unresolved payment refs: ' + inputErrors.slice(0, 25).join('; '));
        }

        var customerPaymentArray = buildCustomerPaymentGroups(customerFailedLookup, fileObj.id, fileObj.name);
        var billPaymentArray = buildBillPaymentGroups(billFailedLookup, fileObj.id, fileObj.name);
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
            processCustomerPaymentGroup(data);
            context.write({ key: 'fileId', value: data.fileId });
            return;
        }

        if (data.processType === PROCESS_BILL) {
            processBillPaymentGroup(data);
            context.write({ key: 'fileId', value: data.fileId });
            return;
        }

        throw new Error('Unknown process type: ' + data.processType);
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
                return;
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
        });

        log.audit('ACH Return Transactions Identified', {
            failedRefs: Object.keys(failedLookup).length,
            matchedRefs: Object.keys(tranLookup).length
        });

        return tranLookup;
    }

    function findTransactionByReference(paymentRef) {
        var results = search.create({
            type: 'transaction',
            settings: [{ name: 'consolidationtype', value: 'ACCTTYPE' }],
            filters: [
                ['type', 'anyof', 'CustPymt', 'VendPymt'],
                'AND',
                ['mainline', 'is', 'T'],
                'AND',
                ['trandate', 'within', 'daysago' + DAYS_BACK, 'daysago0'],
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
        var groups = {};
        var foundFailedRefs = {};

        if (!failedRefs.length) return [];

        runPaged(search.create({
            type: 'customerpayment',
            settings: [{ name: 'consolidationtype', value: 'ACCTTYPE' }],
            filters: [
                ['type', 'anyof', 'CustPymt'],
                'AND',
                [BATCH_FIELD, 'noneof', '@NONE@'],
                'AND',
                ['trandate', 'within', 'daysago' + DAYS_BACK, 'daysago0'],
                'AND',
                ['appliedtotransaction.type', 'anyof', 'CustInvc']
            ],
            columns: [
                'internalid',
                'tranid',
                'trandate',
                BATCH_FIELD,
                'entity',
                'account',
                'amount',
                'appliedtotransaction',
                'appliedtolinkamount'
            ]
        }), function (result) {
            var paymentId = String(result.getValue({ name: 'internalid' }));
            var ref = clean(result.getValue({ name: 'tranid' }));
            var batchId = result.getValue({ name: BATCH_FIELD });
            var customerId = result.getValue({ name: 'entity' });
            var accountId = result.getValue({ name: 'account' });
            var accountName = String(result.getText({ name: 'account' }) || '');
            var paymentAmount = Math.abs(money(result.getValue({ name: 'amount' })));
            var invoiceId = result.getValue({ name: 'appliedtotransaction' });
            var appliedAmount = Math.abs(money(result.getValue({ name: 'appliedtolinkamount' })));
            var failed = customerFailedLookup[ref];
            var key = [batchId, customerId, accountId].join('_');

            if (!paymentId || !batchId || !customerId || !accountId || !paymentAmount || !invoiceId || !appliedAmount) return;

            if (!groups[key]) {
                groups[key] = {
                    processType: PROCESS_CUSTOMER,
                    fileId: String(fileId),
                    fileName: fileName,
                    key: key,
                    batchId: String(batchId),
                    customerId: String(customerId),
                    accountId: String(accountId),
                    accountName: accountName,
                    passedPayments: [],
                    failedPayments: [],
                    totals: {
                        batchAmount: 0,
                        failedAmount: 0,
                        availableAmount: 0
                    },
                    invoiceAmounts: {},
                    paymentMap: {}
                };
            }

            var payment = groups[key].paymentMap[paymentId];

            if (!payment) {
                payment = {
                    paymentId: paymentId,
                    paymentRef: ref,
                    paymentDate: result.getValue({ name: 'trandate' }),
                    amount: paymentAmount,
                    appliedInvoices: []
                };

                groups[key].paymentMap[paymentId] = payment;
                groups[key].totals.batchAmount = round(groups[key].totals.batchAmount + paymentAmount);

                if (failed) {
                    foundFailedRefs[failed.csvPaymentRef || ref] = true;
                    payment.returnedAmount = failed.returnedAmount;
                    payment.returnCode = failed.returnCode;
                    payment.returnReason = failed.returnReason;
                    groups[key].failedPayments.push(payment);

                    log.debug('Customer Failed Payment Matched', {
                        key: key,
                        paymentId: paymentId,
                        paymentRef: ref,
                        returnedAmount: failed.returnedAmount,
                        batchId: batchId,
                        customerId: customerId,
                        accountId: accountId
                    });
                } else {
                    groups[key].passedPayments.push(payment);
                }
            }

            invoiceId = String(invoiceId);
            payment.appliedInvoices.push({
                invoiceId: invoiceId,
                appliedAmount: appliedAmount
            });
            groups[key].invoiceAmounts[invoiceId] = round((groups[key].invoiceAmounts[invoiceId] || 0) + appliedAmount);
        });

        var output = Object.keys(groups).reduce(function (list, key) {
            var group = groups[key];

            if (!group.failedPayments.length) return list;

            group.totals.failedAmount = group.failedPayments.reduce(function (total, payment) {
                return round(total + money(payment.returnedAmount));
            }, 0);
            group.totals.availableAmount = Math.max(0, round(group.totals.batchAmount - group.totals.failedAmount));

            prepareCustomerAllocation(group);
            delete group.paymentMap;
            list.push(group);
            return list;
        }, []);

        var unmatchedRefs = failedRefs.filter(function (ref) {
            return !foundFailedRefs[customerFailedLookup[ref].csvPaymentRef || ref];
        });

        if (unmatchedRefs.length) {
            throw new Error('Customer payments were found but not available in batch/apply search: ' + unmatchedRefs.slice(0, 25).join(', '));
        }

        log.audit('Customer Return Groups Built', {
            groups: output.length,
            unmatchedFailedRefs: unmatchedRefs
        });

        return output;
    }

    function buildBillPaymentGroups(billFailedLookup, fileId, fileName) {
        var failedRefs = Object.keys(billFailedLookup);
        var groups = {};
        var foundFailedRefs = {};

        if (!failedRefs.length) return [];

        runPaged(search.create({
            type: 'vendorpayment',
            settings: [{ name: 'consolidationtype', value: 'ACCTTYPE' }],
            filters: [
                ['type', 'anyof', 'VendPymt'],
                'AND',
                [BATCH_FIELD, 'noneof', '@NONE@'],
                'AND',
                ['trandate', 'within', 'daysago' + DAYS_BACK, 'daysago0'],
                'AND',
                ['appliedtotransaction.type', 'anyof', 'VendBill']
            ],
            columns: [
                'internalid',
                'tranid',
                'trandate',
                BATCH_FIELD,
                'entity',
                'accountmain',
                'account',
                'amount',
                'appliedtotransaction',
                'appliedtolinkamount'
            ]
        }), function (result) {
            var paymentId = String(result.getValue({ name: 'internalid' }));
            var ref = clean(result.getValue({ name: 'tranid' }));
            var batchId = result.getValue({ name: BATCH_FIELD });
            var vendorId = result.getValue({ name: 'entity' });
            var accountId = result.getValue({ name: 'accountmain' }) || result.getValue({ name: 'account' });
            var accountName = String(result.getText({ name: 'accountmain' }) || result.getText({ name: 'account' }) || '');
            var paymentAmount = Math.abs(money(result.getValue({ name: 'amount' })));
            var billId = result.getValue({ name: 'appliedtotransaction' });
            var appliedAmount = Math.abs(money(result.getValue({ name: 'appliedtolinkamount' })));
            var failed = billFailedLookup[ref];
            var key = [batchId, vendorId, accountId].join('_');

            if (!paymentId || !batchId || !vendorId || !accountId || !paymentAmount || !billId || !appliedAmount) return;

            if (!groups[key]) {
                groups[key] = {
                    processType: PROCESS_BILL,
                    fileId: String(fileId),
                    fileName: fileName,
                    key: key,
                    batchId: String(batchId),
                    vendorId: String(vendorId),
                    accountId: String(accountId),
                    accountName: accountName,
                    passedPayments: [],
                    failedPayments: [],
                    totals: {
                        batchAmount: 0,
                        failedAmount: 0,
                        availableAmount: 0
                    },
                    billAmounts: {},
                    paymentMap: {}
                };
            }

            var payment = groups[key].paymentMap[paymentId];

            if (!payment) {
                payment = {
                    paymentId: paymentId,
                    paymentRef: ref,
                    paymentDate: result.getValue({ name: 'trandate' }),
                    amount: paymentAmount,
                    appliedBills: []
                };

                groups[key].paymentMap[paymentId] = payment;
                groups[key].totals.batchAmount = round(groups[key].totals.batchAmount + paymentAmount);

                if (failed) {
                    foundFailedRefs[failed.csvPaymentRef || ref] = true;
                    payment.returnedAmount = failed.returnedAmount;
                    payment.returnCode = failed.returnCode;
                    payment.returnReason = failed.returnReason;
                    groups[key].failedPayments.push(payment);

                    log.debug('Bill Failed Payment Matched', {
                        key: key,
                        paymentId: paymentId,
                        paymentRef: ref,
                        returnedAmount: failed.returnedAmount,
                        batchId: batchId,
                        vendorId: vendorId,
                        accountId: accountId
                    });
                } else {
                    groups[key].passedPayments.push(payment);
                }
            }

            billId = String(billId);
            payment.appliedBills.push({
                billId: billId,
                appliedAmount: appliedAmount
            });
            groups[key].billAmounts[billId] = round((groups[key].billAmounts[billId] || 0) + appliedAmount);
        });

        var output = Object.keys(groups).reduce(function (list, key) {
            var group = groups[key];

            if (!group.failedPayments.length) return list;

            group.totals.failedAmount = group.failedPayments.reduce(function (total, payment) {
                return round(total + money(payment.returnedAmount));
            }, 0);
            group.totals.availableAmount = Math.max(0, round(group.totals.batchAmount - group.totals.failedAmount));

            prepareBillAllocation(group);
            delete group.paymentMap;
            list.push(group);
            return list;
        }, []);

        var unmatchedRefs = failedRefs.filter(function (ref) {
            return !foundFailedRefs[billFailedLookup[ref].csvPaymentRef || ref];
        });

        if (unmatchedRefs.length) {
            throw new Error('Bill payments were found but not available in batch/apply search: ' + unmatchedRefs.slice(0, 25).join(', '));
        }

        log.audit('Bill Return Groups Built', {
            groups: output.length,
            unmatchedFailedRefs: unmatchedRefs
        });

        return output;
    }

    function prepareBillAllocation(group) {
        var billAmounts = group.billAmounts || {};
        var billIds = Object.keys(billAmounts);
        var billInfo = {};

        if (billIds.length) {
            runPaged(search.create({
                type: search.Type.VENDOR_BILL,
                filters: [
                    ['internalid', 'anyof', billIds],
                    'AND',
                    ['mainline', 'is', 'T']
                ],
                columns: [
                    'internalid',
                    'tranid',
                    'trandate'
                ]
            }), function (result) {
                var billId = String(result.getValue({ name: 'internalid' }));

                billInfo[billId] = {
                    billId: billId,
                    billNumber: result.getValue({ name: 'tranid' }),
                    billDate: result.getValue({ name: 'trandate' }),
                    billDateTime: dateTime(result.getValue({ name: 'trandate' }))
                };
            });
        }

        billIds.forEach(function (billId) {
            if (!billInfo[billId]) {
                billInfo[billId] = {
                    billId: billId,
                    billNumber: '',
                    billDate: '',
                    billDateTime: 9999999999999
                };
            }
        });

        billIds.sort(function (a, b) {
            return billInfo[a].billDateTime - billInfo[b].billDateTime ||
                Number(a) - Number(b);
        });

        var remaining = group.totals.availableAmount;
        var desiredByBill = {};
        var allocation = { full: 0, partial: 0, unpaid: 0 };
        var details = [];

        billIds.forEach(function (billId) {
            var currentAmount = billAmounts[billId];
            var desiredAmount = round(Math.min(currentAmount, remaining));

            desiredByBill[billId] = desiredAmount;
            remaining = round(remaining - desiredAmount);

            if (desiredAmount >= currentAmount - 0.009) allocation.full++;
            else if (desiredAmount > 0) allocation.partial++;
            else allocation.unpaid++;

            details.push({
                billId: billId,
                billNumber: billInfo[billId].billNumber,
                billDate: billInfo[billId].billDate,
                currentAmount: currentAmount,
                desiredAmount: desiredAmount
            });
        });

        group.desiredByBill = desiredByBill;
        group.allocation = allocation;
        group.billAllocationDetails = details;

        log.audit('Bill Allocation Prepared', {
            key: group.key,
            bills: billIds.length,
            full: allocation.full,
            partial: allocation.partial,
            unpaid: allocation.unpaid,
            unusedAmount: remaining
        });
        log.debug('Bill Allocation Detail', {
            key: group.key,
            detailsShown: Math.min(details.length, 25),
            details: details.slice(0, 25)
        });
    }

    function prepareCustomerAllocation(group) {
        var accountName = String(group.accountName || '');
        var itemSeqField = OPERATING_SEQ_FIELD;
        var invoiceAmounts = group.invoiceAmounts || {};
        var invoiceIds = Object.keys(invoiceAmounts);
        var invoiceInfo = {};

        if (accountName.indexOf('- NAF - USD -') !== -1 || accountName.indexOf('- NAF - CAD -') !== -1) {
            itemSeqField = NAF_SEQ_FIELD;
        }

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

                if (!invoiceInfo[invoiceId]) {
                    invoiceInfo[invoiceId] = {
                        invoiceId: invoiceId,
                        invoiceNumber: result.getValue({ name: 'tranid' }),
                        invoiceDate: result.getValue({ name: 'trandate' }),
                        invoiceDateTime: dateTime(result.getValue({ name: 'trandate' })),
                        itemSequence: seq
                    };
                } else if (seq < invoiceInfo[invoiceId].itemSequence) {
                    invoiceInfo[invoiceId].itemSequence = seq;
                }
            });
        }

        invoiceIds.forEach(function (invoiceId) {
            if (!invoiceInfo[invoiceId]) {
                invoiceInfo[invoiceId] = {
                    invoiceId: invoiceId,
                    invoiceNumber: '',
                    invoiceDate: '',
                    invoiceDateTime: 9999999999999,
                    itemSequence: 999999999
                };
            }
        });

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
            var currentAmount = invoiceAmounts[invoiceId];
            var desiredAmount = round(Math.min(currentAmount, remaining));

            desiredByInvoice[invoiceId] = desiredAmount;
            remaining = round(remaining - desiredAmount);

            if (desiredAmount >= currentAmount - 0.009) allocation.full++;
            else if (desiredAmount > 0) allocation.partial++;
            else allocation.unpaid++;

            details.push({
                invoiceId: invoiceId,
                invoiceNumber: invoiceInfo[invoiceId].invoiceNumber,
                invoiceDate: invoiceInfo[invoiceId].invoiceDate,
                itemSequence: invoiceInfo[invoiceId].itemSequence,
                currentAmount: currentAmount,
                desiredAmount: desiredAmount
            });
        });

        group.itemSeqField = itemSeqField;
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
        var desiredByInvoice = {};
        var payments = group.passedPayments.concat(group.failedPayments).sort(function (a, b) {
            return dateTime(a.paymentDate) - dateTime(b.paymentDate) ||
                String(a.paymentRef).localeCompare(String(b.paymentRef)) ||
                Number(a.paymentId) - Number(b.paymentId);
        });

        Object.keys(group.desiredByInvoice || {}).forEach(function (invoiceId) {
            desiredByInvoice[invoiceId] = group.desiredByInvoice[invoiceId];
        });

        log.audit('Customer Group Start', {
            key: group.key,
            batchId: group.batchId,
            customerId: group.customerId,
            accountId: group.accountId,
            accountName: group.accountName,
            itemSeqField: group.itemSeqField,
            payments: payments.length,
            failedPayments: group.failedPayments.length,
            availableAmount: group.totals.availableAmount,
            allocation: group.allocation
        });

        payments.forEach(function (payment) {
            var paymentRecord = record.load({
                type: record.Type.CUSTOMER_PAYMENT,
                id: payment.paymentId,
                isDynamic: false
            });
            var lineCount = paymentRecord.getLineCount({ sublistId: 'apply' });
            var bodyPaymentBefore = money(paymentRecord.getValue({ fieldId: 'payment' }));
            var changed = false;
            var hadGroupApply = false;
            var keptGroupAmount = 0;
            var outsideAmount = 0;
            var appliedBefore = 0;
            var hasOutsideApply = false;

            log.debug('Customer Payment Edit Start', {
                paymentId: payment.paymentId,
                paymentRef: payment.paymentRef,
                bodyPaymentBefore: bodyPaymentBefore,
                lineCount: lineCount
            });

            for (var beforeLine = 0; beforeLine < lineCount; beforeLine++) {
                if (paymentRecord.getSublistValue({ sublistId: 'apply', fieldId: 'apply', line: beforeLine })) {
                    appliedBefore = round(appliedBefore + money(paymentRecord.getSublistValue({
                        sublistId: 'apply',
                        fieldId: 'amount',
                        line: beforeLine
                    })));
                }
            }

            for (var i = 0; i < lineCount; i++) {
                var applied = paymentRecord.getSublistValue({ sublistId: 'apply', fieldId: 'apply', line: i });
                var invoiceId = paymentRecord.getSublistValue({ sublistId: 'apply', fieldId: 'doc', line: i });
                var currentAmount = money(paymentRecord.getSublistValue({ sublistId: 'apply', fieldId: 'amount', line: i }));

                if (!applied || !invoiceId || currentAmount <= 0) continue;

                invoiceId = String(invoiceId);

                if ((group.invoiceAmounts || {})[invoiceId] === undefined) {
                    hasOutsideApply = true;
                    outsideAmount = round(outsideAmount + currentAmount);
                    log.debug('Customer Apply Line Outside Group', {
                        paymentId: payment.paymentId,
                        paymentRef: payment.paymentRef,
                        line: i,
                        invoiceId: invoiceId,
                        currentAmount: currentAmount
                    });
                    continue;
                }

                hadGroupApply = true;

                var desiredBefore = desiredByInvoice[invoiceId] || 0;
                var allowedAmount = round(Math.min(currentAmount, desiredBefore));
                var lineChanged = false;

                desiredByInvoice[invoiceId] = round((desiredByInvoice[invoiceId] || 0) - allowedAmount);
                keptGroupAmount = round(keptGroupAmount + allowedAmount);

                if (allowedAmount > 0 && Math.abs(currentAmount - allowedAmount) > 0.009) {
                    paymentRecord.setSublistValue({ sublistId: 'apply', fieldId: 'apply', line: i, value: true });
                    paymentRecord.setSublistValue({ sublistId: 'apply', fieldId: 'amount', line: i, value: allowedAmount });
                    changed = true;
                    lineChanged = true;
                } else if (allowedAmount <= 0) {
                    paymentRecord.setSublistValue({ sublistId: 'apply', fieldId: 'apply', line: i, value: false });
                    changed = true;
                    lineChanged = true;
                }

                log.debug('Customer Apply Line Decision', {
                    paymentId: payment.paymentId,
                    paymentRef: payment.paymentRef,
                    line: i,
                    invoiceId: invoiceId,
                    currentAmount: currentAmount,
                    desiredBefore: desiredBefore,
                    allowedAmount: allowedAmount,
                    desiredAfter: desiredByInvoice[invoiceId],
                    lineChanged: lineChanged
                });
            }

            var targetAppliedAmount = round(keptGroupAmount + outsideAmount);
            var jeAmount = hadGroupApply ? round(bodyPaymentBefore - targetAppliedAmount) : 0;
            var returnJeId = '';

            if (hadGroupApply && jeAmount > 0.009) {
                changed = true;
                log.debug('Customer Payment JE Needed', {
                    paymentId: payment.paymentId,
                    paymentRef: payment.paymentRef,
                    bodyPaymentBefore: bodyPaymentBefore,
                    targetAppliedAmount: targetAppliedAmount,
                    keptGroupAmount: keptGroupAmount,
                    outsideAmount: outsideAmount,
                    jeAmount: jeAmount
                });
            }

            if (hadGroupApply && keptGroupAmount <= 0 && !hasOutsideApply) {
                var memo = String(paymentRecord.getValue({ fieldId: 'memo' }) || '');

                if (memo.indexOf(VOID_MEMO_TEXT) === -1) {
                    paymentRecord.setValue({
                        fieldId: 'memo',
                        value: memo ? memo + ' | ' + VOID_MEMO_TEXT : VOID_MEMO_TEXT
                    });
                    changed = true;
                }
            }

            if (changed) {
                log.debug('Customer Payment Save Attempt', {
                    paymentId: payment.paymentId,
                    paymentRef: payment.paymentRef,
                    bodyPaymentBefore: bodyPaymentBefore,
                    targetAppliedAmount: targetAppliedAmount,
                    jeAmount: jeAmount,
                    appliedBefore: appliedBefore,
                    keptGroupAmount: keptGroupAmount,
                    outsideAmount: outsideAmount,
                    hadGroupApply: hadGroupApply,
                    hasOutsideApply: hasOutsideApply
                });

                var savedId = paymentRecord.save({ enableSourcing: false, ignoreMandatoryFields: true });

                if (jeAmount > 0.009) {
                    returnJeId = createCustomerPaymentJeAndApply(savedId, jeAmount, payment.paymentRef);

                    log.audit('Customer Payment JE Applied', {
                        paymentId: savedId,
                        paymentRef: payment.paymentRef,
                        journalId: returnJeId,
                        jeAmount: jeAmount
                    });
                }

                var savedRecord = record.load({
                    type: record.Type.CUSTOMER_PAYMENT,
                    id: savedId,
                    isDynamic: false
                });
                var savedApplied = 0;
                var savedLineCount = savedRecord.getLineCount({ sublistId: 'apply' });

                for (var savedLine = 0; savedLine < savedLineCount; savedLine++) {
                    if (savedRecord.getSublistValue({ sublistId: 'apply', fieldId: 'apply', line: savedLine })) {
                        savedApplied = round(savedApplied + money(savedRecord.getSublistValue({
                            sublistId: 'apply',
                            fieldId: 'amount',
                            line: savedLine
                        })));
                    }
                }

                log.audit('Customer Payment Updated', {
                    paymentId: payment.paymentId,
                    paymentRef: payment.paymentRef,
                    keptAmount: keptGroupAmount,
                    bodyPaymentBefore: bodyPaymentBefore,
                    targetAppliedAmount: targetAppliedAmount,
                    savedBodyPayment: money(savedRecord.getValue({ fieldId: 'payment' })),
                    savedAppliedAmount: savedApplied,
                    returnJeId: returnJeId,
                    memoVoided: hadGroupApply && keptGroupAmount <= 0 && !hasOutsideApply
                });
            } else {
                log.debug('Customer Payment No Change', {
                    paymentId: payment.paymentId,
                    paymentRef: payment.paymentRef,
                    bodyPaymentBefore: bodyPaymentBefore,
                    appliedBefore: appliedBefore,
                    keptGroupAmount: keptGroupAmount,
                    outsideAmount: outsideAmount,
                    hadGroupApply: hadGroupApply,
                    hasOutsideApply: hasOutsideApply
                });
            }
        });

        var desiredLeft = Object.keys(desiredByInvoice).filter(function (invoiceId) {
            return Math.abs(desiredByInvoice[invoiceId]) > 0.009;
        }).map(function (invoiceId) {
            return {
                invoiceId: invoiceId,
                amountLeft: desiredByInvoice[invoiceId]
            };
        });

        log.audit('Customer Group Complete', {
            key: group.key,
            desiredLeftCount: desiredLeft.length,
            desiredLeft: desiredLeft.slice(0, 25)
        });
    }

    function createCustomerPaymentJeAndApply(paymentId, jeAmount, paymentRef) {
        var paymentHeader = record.load({
            type: record.Type.CUSTOMER_PAYMENT,
            id: paymentId,
            isDynamic: false
        });
        var customerId = paymentHeader.getValue({ fieldId: 'customer' }) || paymentHeader.getValue({ fieldId: 'entity' });
        var subsidiaryId = paymentHeader.getValue({ fieldId: 'subsidiary' });
        var currencyId = paymentHeader.getValue({ fieldId: 'currency' });
        var mainInfo = {};
        var lineMap = {};
        var jeLines = [];
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
                jeLines.push(lineMap[key]);
            }

            lineMap[key].sourceDebit = round(lineMap[key].sourceDebit + debitAmount);
            lineMap[key].sourceCredit = round(lineMap[key].sourceCredit + creditAmount);
            sourceDebitTotal = round(sourceDebitTotal + debitAmount);
            sourceCreditTotal = round(sourceCreditTotal + creditAmount);
        });

        if (!jeLines.length) throw new Error('No non-main GL lines found for Customer Payment ' + paymentId);

        scaleJeLines(jeLines, sourceDebitTotal, sourceCreditTotal, jeAmount);
        balanceJeLines(jeLines, mainInfo);

        log.debug('Customer Payment JE Lines Prepared', {
            paymentId: paymentId,
            paymentRef: paymentRef,
            jeAmount: jeAmount,
            mainInfo: mainInfo,
            sourceDebitTotal: sourceDebitTotal,
            sourceCreditTotal: sourceCreditTotal,
            lines: jeLines
        });

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
            jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'entity', value: line.entity || mainInfo.entity || customerId });
            jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'memo', value: memoText });
            if (line.department || mainInfo.department) jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'department', value: line.department || mainInfo.department });
            if (line.classId || mainInfo.classId) jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'class', value: line.classId || mainInfo.classId });
            if (line.location || mainInfo.location) jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'location', value: line.location || mainInfo.location });
            if (line.debit) jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'debit', value: line.debit });
            if (line.credit) jeRecord.setCurrentSublistValue({ sublistId: 'line', fieldId: 'credit', value: line.credit });
            jeRecord.commitLine({ sublistId: 'line' });
        });

        var jeId = jeRecord.save();
        var applyPayment = record.load({
            type: record.Type.CUSTOMER_PAYMENT,
            id: paymentId,
            isDynamic: false
        });
        var applyCount = applyPayment.getLineCount({ sublistId: 'apply' });
        var appliedJe = false;

        for (var i = 0; i < applyCount; i++) {
            var applyInternalId = String(applyPayment.getSublistValue({ sublistId: 'apply', fieldId: 'internalid', line: i }) || '');
            var applyDocId = String(applyPayment.getSublistValue({ sublistId: 'apply', fieldId: 'doc', line: i }) || '');

            if (applyInternalId === String(jeId) || applyDocId === String(jeId)) {
                applyPayment.setSublistValue({ sublistId: 'apply', fieldId: 'apply', line: i, value: true });
                applyPayment.setSublistValue({ sublistId: 'apply', fieldId: 'amount', line: i, value: jeAmount });
                appliedJe = true;
                break;
            }
        }

        if (!appliedJe) {
            throw new Error('Journal Entry ' + jeId + ' was not found on Customer Payment ' + paymentId + ' apply sublist.');
        }

        applyPayment.save({ enableSourcing: false, ignoreMandatoryFields: true });
        return jeId;
    }

    function processBillPaymentGroup(group) {
        var desiredByBill = {};
        var payments = group.passedPayments.concat(group.failedPayments).sort(function (a, b) {
            return dateTime(a.paymentDate) - dateTime(b.paymentDate) ||
                String(a.paymentRef).localeCompare(String(b.paymentRef)) ||
                Number(a.paymentId) - Number(b.paymentId);
        });

        Object.keys(group.desiredByBill || {}).forEach(function (billId) {
            desiredByBill[billId] = group.desiredByBill[billId];
        });

        log.audit('Bill Group Start', {
            key: group.key,
            batchId: group.batchId,
            vendorId: group.vendorId,
            accountId: group.accountId,
            accountName: group.accountName,
            payments: payments.length,
            failedPayments: group.failedPayments.length,
            availableAmount: group.totals.availableAmount,
            allocation: group.allocation
        });

        payments.forEach(function (payment) {
            var paymentRecord = record.load({
                type: record.Type.VENDOR_PAYMENT,
                id: payment.paymentId,
                isDynamic: false
            });
            var lineCount = paymentRecord.getLineCount({ sublistId: 'apply' });
            var bodyPaymentBefore = money(paymentRecord.getValue({ fieldId: 'total' }));
            var changed = false;
            var hadGroupApply = false;
            var keptGroupAmount = 0;
            var outsideAmount = 0;
            var appliedBefore = 0;
            var hasOutsideApply = false;
            var lineActions = [];

            log.debug('Bill Payment Edit Start', {
                paymentId: payment.paymentId,
                paymentRef: payment.paymentRef,
                bodyPaymentBefore: bodyPaymentBefore,
                lineCount: lineCount
            });

            for (var beforeLine = 0; beforeLine < lineCount; beforeLine++) {
                if (paymentRecord.getSublistValue({ sublistId: 'apply', fieldId: 'apply', line: beforeLine })) {
                    appliedBefore = round(appliedBefore + money(paymentRecord.getSublistValue({
                        sublistId: 'apply',
                        fieldId: 'amount',
                        line: beforeLine
                    })));
                }
            }

            for (var i = 0; i < lineCount; i++) {
                var applied = paymentRecord.getSublistValue({ sublistId: 'apply', fieldId: 'apply', line: i });
                var billId = paymentRecord.getSublistValue({ sublistId: 'apply', fieldId: 'doc', line: i });
                var currentAmount = money(paymentRecord.getSublistValue({ sublistId: 'apply', fieldId: 'amount', line: i }));

                if (!applied || !billId || currentAmount <= 0) continue;

                billId = String(billId);

                if ((group.billAmounts || {})[billId] === undefined) {
                    hasOutsideApply = true;
                    outsideAmount = round(outsideAmount + currentAmount);
                    log.debug('Bill Apply Line Outside Group', {
                        paymentId: payment.paymentId,
                        paymentRef: payment.paymentRef,
                        line: i,
                        billId: billId,
                        currentAmount: currentAmount
                    });
                    continue;
                }

                hadGroupApply = true;

                var desiredBefore = desiredByBill[billId] || 0;
                var allowedAmount = round(Math.min(currentAmount, desiredBefore));
                var lineChanged = false;

                desiredByBill[billId] = round((desiredByBill[billId] || 0) - allowedAmount);
                keptGroupAmount = round(keptGroupAmount + allowedAmount);

                if (allowedAmount > 0 && Math.abs(currentAmount - allowedAmount) > 0.009) {
                    paymentRecord.setSublistValue({ sublistId: 'apply', fieldId: 'apply', line: i, value: true });
                    paymentRecord.setSublistValue({ sublistId: 'apply', fieldId: 'amount', line: i, value: allowedAmount });
                    lineActions.push({ line: i, billId: billId, apply: true, amount: allowedAmount });
                    changed = true;
                    lineChanged = true;
                } else if (allowedAmount <= 0) {
                    paymentRecord.setSublistValue({ sublistId: 'apply', fieldId: 'apply', line: i, value: false });
                    lineActions.push({ line: i, billId: billId, apply: false, amount: 0 });
                    changed = true;
                    lineChanged = true;
                }

                log.debug('Bill Apply Line Decision', {
                    paymentId: payment.paymentId,
                    paymentRef: payment.paymentRef,
                    line: i,
                    billId: billId,
                    currentAmount: currentAmount,
                    desiredBefore: desiredBefore,
                    allowedAmount: allowedAmount,
                    desiredAfter: desiredByBill[billId],
                    lineChanged: lineChanged
                });
            }

            var targetAppliedAmount = round(keptGroupAmount + outsideAmount);
            var jeAmount = hadGroupApply ? round(bodyPaymentBefore - targetAppliedAmount) : 0;
            var returnJeId = '';

            if (hadGroupApply && jeAmount > 0.009) {
                changed = true;
                log.debug('Bill Payment JE Needed', {
                    paymentId: payment.paymentId,
                    paymentRef: payment.paymentRef,
                    bodyPaymentBefore: bodyPaymentBefore,
                    targetAppliedAmount: targetAppliedAmount,
                    keptGroupAmount: keptGroupAmount,
                    outsideAmount: outsideAmount,
                    jeAmount: jeAmount
                });
            }

            if (hadGroupApply && keptGroupAmount <= 0 && !hasOutsideApply) {
                var memo = String(paymentRecord.getValue({ fieldId: 'memo' }) || '');

                if (memo.indexOf(VOID_MEMO_TEXT) === -1) {
                    paymentRecord.setValue({
                        fieldId: 'memo',
                        value: memo ? memo + ' | ' + VOID_MEMO_TEXT : VOID_MEMO_TEXT
                    });
                    changed = true;
                }
            }

            if (changed) {
                log.debug('Bill Payment Save Attempt', {
                    paymentId: payment.paymentId,
                    paymentRef: payment.paymentRef,
                    bodyPaymentBefore: bodyPaymentBefore,
                    targetAppliedAmount: targetAppliedAmount,
                    jeAmount: jeAmount,
                    appliedBefore: appliedBefore,
                    keptGroupAmount: keptGroupAmount,
                    outsideAmount: outsideAmount,
                    hadGroupApply: hadGroupApply,
                    hasOutsideApply: hasOutsideApply
                });

                var savedId;

                if (jeAmount > 0.009) {
                    returnJeId = createBillPaymentJe(payment.paymentId, jeAmount, payment.paymentRef);
                    paymentRecord = record.load({
                        type: record.Type.VENDOR_PAYMENT,
                        id: payment.paymentId,
                        isDynamic: false
                    });

                    applyBillPaymentLineActions(paymentRecord, lineActions);

                    var freshMemo = String(paymentRecord.getValue({ fieldId: 'memo' }) || '');

                    if (freshMemo.indexOf(VOID_MEMO_TEXT) === -1) {
                        paymentRecord.setValue({
                            fieldId: 'memo',
                            value: freshMemo ? freshMemo + ' | ' + VOID_MEMO_TEXT : VOID_MEMO_TEXT
                        });
                    }

                    try {
                        paymentRecord.setValue({ fieldId: UNAPPLIED_DATE_FIELD, value: new Date() });
                    } catch (e) {
                        log.debug('Bill Payment Unapplied Date Not Set', e.message);
                    }

                    applyBillPaymentJeLine(paymentRecord, returnJeId, jeAmount);
                    savedId = paymentRecord.save({ enableSourcing: false, ignoreMandatoryFields: true });

                    log.audit('Bill Payment JE Applied', {
                        paymentId: savedId,
                        paymentRef: payment.paymentRef,
                        journalId: returnJeId,
                        jeAmount: jeAmount,
                        saveMode: 'JE_BEFORE_PAYMENT_SAVE'
                    });
                } else {
                    savedId = paymentRecord.save({ enableSourcing: false, ignoreMandatoryFields: true });
                }

                log.audit('Bill Payment Updated', {
                    paymentId: payment.paymentId,
                    paymentRef: payment.paymentRef,
                    keptAmount: keptGroupAmount,
                    bodyPaymentBefore: bodyPaymentBefore,
                    targetAppliedAmount: targetAppliedAmount,
                    returnJeId: returnJeId,
                    memoVoided: hadGroupApply && keptGroupAmount <= 0 && !hasOutsideApply
                });
            } else {
                log.debug('Bill Payment No Change', {
                    paymentId: payment.paymentId,
                    paymentRef: payment.paymentRef,
                    bodyPaymentBefore: bodyPaymentBefore,
                    appliedBefore: appliedBefore,
                    keptGroupAmount: keptGroupAmount,
                    outsideAmount: outsideAmount,
                    hadGroupApply: hadGroupApply,
                    hasOutsideApply: hasOutsideApply
                });
            }
        });

        var desiredLeft = Object.keys(desiredByBill).filter(function (billId) {
            return Math.abs(desiredByBill[billId]) > 0.009;
        }).map(function (billId) {
            return {
                billId: billId,
                amountLeft: desiredByBill[billId]
            };
        });

        log.audit('Bill Group Complete', {
            key: group.key,
            desiredLeftCount: desiredLeft.length,
            desiredLeft: desiredLeft.slice(0, 25)
        });
    }

    function createBillPaymentJe(paymentId, jeAmount, paymentRef) {
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

        jeAmount = round(jeAmount);

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

        log.audit('Bill Payment JE Created', {
            paymentId: paymentId,
            paymentRef: paymentRef,
            paymentTotal: paymentTotal,
            jeAmount: jeAmount,
            journalId: jeId,
            lines: jeLines
        });

        return jeId;
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

    function applyBillPaymentLineActions(paymentRecord, lineActions) {
        var lineCount = paymentRecord.getLineCount({ sublistId: 'apply' });

        (lineActions || []).forEach(function (action) {
            var line = Number(action.line);

            if (line >= 0 && line < lineCount && String(paymentRecord.getSublistValue({
                sublistId: 'apply',
                fieldId: 'doc',
                line: line
            })) === String(action.billId)) {
                paymentRecord.setSublistValue({ sublistId: 'apply', fieldId: 'apply', line: line, value: action.apply });
                if (action.apply) paymentRecord.setSublistValue({ sublistId: 'apply', fieldId: 'amount', line: line, value: action.amount });
                return;
            }

            for (var i = 0; i < lineCount; i++) {
                if (String(paymentRecord.getSublistValue({ sublistId: 'apply', fieldId: 'doc', line: i })) === String(action.billId)) {
                    paymentRecord.setSublistValue({ sublistId: 'apply', fieldId: 'apply', line: i, value: action.apply });
                    if (action.apply) paymentRecord.setSublistValue({ sublistId: 'apply', fieldId: 'amount', line: i, value: action.amount });
                    return;
                }
            }
        });
    }

    function applyBillPaymentJeLine(paymentRecord, jeId, jeAmount) {
        var lineCount = paymentRecord.getLineCount({ sublistId: 'apply' });

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
                } catch (e) {
                    log.debug('Bill Payment JE Apply Amount Not Set', e.message);
                }

                return true;
            }
        }

        throw new Error('Journal Entry ' + jeId + ' was not found on Bill Payment apply sublist.');
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
        summarize: summarize
    };
});
