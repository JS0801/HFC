/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/file', 'N/search', 'N/record', 'N/format'], function (file, search, record, format) {
    var RETURN_FOLDER_ID = '329224';
    var PROCESSED_FOLDERID = '329225';
    var DAYS_BACK = 30;
    var BATCH_FIELD = 'custbody_9997_pfa_record';
    var OPERATING_SEQ_FIELD = 'custitem_operating_seq';
    var NAF_SEQ_FIELD = 'custitem_naf_seq';
    var VOID_MEMO_TEXT = 'ACH RETURN VOIDED';

    function getInputData() {
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
            return [];
        }

        var csvFileId = latest.getValue({ name: 'internalid' });
        var csvName = latest.getValue({ name: 'name' });
        var fileObj = file.load({ id: csvFileId });
        var rows = parseCsv(fileObj.getContents());
        var failedLookup = {};
        var failedCsvTotal = 0;

        // rows.forEach(function (row) {
        //     var ref = String(row['Recipient ID'] || '').trim();
        //     var returnedAmount = money(row['Debit Amount']);

        //     if (ref && returnedAmount > 0) {
        //         failedLookup[ref] = {
        //             paymentRef: ref,
        //             returnedAmount: returnedAmount,
        //             returnCode: String(row['Return Reason Code'] || '').trim(),
        //             returnReason: String(row['Return Reason Description'] || '').trim()
        //         };
        //         failedCsvTotal = round(failedCsvTotal + returnedAmount);
        //     }
        // });


        var pendingReturnRow = null;

rows.forEach(function (row) {
    var recipientId = String(row['Recipient ID'] || '').trim();
    var returnedAmount = money(row['Debit Amount']);
    var addenda = String(row['Addenda'] || '').trim();
    var paymentMatch = addenda.match(/TRANSACTION REFERENCE:\s*(PYMT[0-9A-Za-z_-]+)/i);
    var ref = recipientId.indexOf('PYMT') === 0 ? recipientId : '';

    if (ref && returnedAmount > 0) {
        failedLookup[ref] = {
            paymentRef: ref,
            returnedAmount: returnedAmount,
            returnCode: String(row['Return Reason Code'] || '').trim(),
            returnReason: String(row['Return Reason Description'] || '').trim()
        };
        failedCsvTotal = round(failedCsvTotal + returnedAmount);
        pendingReturnRow = null;
        return;
    }

    if (!recipientId && paymentMatch && pendingReturnRow) {
        ref = paymentMatch[1];

        failedLookup[ref] = {
            paymentRef: ref,
            returnedAmount: pendingReturnRow.returnedAmount,
            returnCode: pendingReturnRow.returnCode,
            returnReason: pendingReturnRow.returnReason
        };
        failedCsvTotal = round(failedCsvTotal + pendingReturnRow.returnedAmount);
        pendingReturnRow = null;
        return;
    }

    if (returnedAmount > 0) {
        pendingReturnRow = {
            returnedAmount: returnedAmount,
            returnCode: String(row['Return Reason Code'] || '').trim(),
            returnReason: String(row['Return Reason Description'] || '').trim()
        };
    }
});


      log.debug('failedLookup', failedLookup) 

        var failedRefs = Object.keys(failedLookup);
        log.audit('ACH Return CSV Loaded', {
            fileId: csvFileId,
            fileName: csvName,
            rows: rows.length,
            failedRefs: failedRefs.length,
            failedCsvTotal: failedCsvTotal
        });

        if (!failedRefs.length) return [];

        var groups = {};
        var foundFailedRefs = {};

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
            var ref = String(result.getValue({ name: 'tranid' }) || '').trim();
            var batchId = result.getValue({ name: BATCH_FIELD });
            var customerId = result.getValue({ name: 'entity' });
            var accountId = result.getValue({ name: 'account' });
            var accountName = String(result.getText({ name: 'account' }) || '');
            var paymentAmount = Math.abs(money(result.getValue({ name: 'amount' })));
            var invoiceId = result.getValue({ name: 'appliedtotransaction' });
            var appliedAmount = Math.abs(money(result.getValue({ name: 'appliedtolinkamount' })));
            var failed = failedLookup[ref];
            var key = [batchId, customerId, accountId].join('_');

            if (!paymentId || !batchId || !customerId || !accountId || !paymentAmount || !invoiceId || !appliedAmount) return;

            if (!groups[key]) {
                groups[key] = {
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
                    foundFailedRefs[ref] = true;
                    payment.returnedAmount = failed.returnedAmount;
                    payment.returnCode = failed.returnCode;
                    payment.returnReason = failed.returnReason;
                    groups[key].failedPayments.push(payment);
                    groups[key].totals.failedAmount = round(groups[key].totals.failedAmount + failed.returnedAmount);

                    log.debug('ACH Failed Payment Matched', {
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

            group.totals.availableAmount = Math.max(0, round(group.totals.batchAmount - group.totals.failedAmount));

            log.debug('ACH Group Prepared', {
                key: key,
                batchId: group.batchId,
                customerId: group.customerId,
                accountId: group.accountId,
                passedPayments: group.passedPayments.length,
                failedPayments: group.failedPayments.length,
                invoiceCount: Object.keys(group.invoiceAmounts).length,
                batchAmount: group.totals.batchAmount,
                failedAmount: group.totals.failedAmount,
                availableAmount: group.totals.availableAmount
            });

            delete group.paymentMap;
            list.push(JSON.stringify(group));
            return list;
        }, []);

        var missingRefs = failedRefs.filter(function (ref) { return !foundFailedRefs[ref]; });

        log.audit('ACH Return Groups Built', {
            groups: output.length,
            unmatchedFailedRefs: missingRefs.length,
            unmatchedRefs: missingRefs.slice(0, 25)
        });

        fileObj.folder = PROCESSED_FOLDERID;
        fileObj.save();
      
        return output;
    }

    function map(context) {
        var group = JSON.parse(context.value);
        var payments = group.passedPayments.concat(group.failedPayments).sort(function (a, b) {
            return dateTime(a.paymentDate) - dateTime(b.paymentDate) ||
                String(a.paymentRef).localeCompare(String(b.paymentRef)) ||
                Number(a.paymentId) - Number(b.paymentId);
        });
        var invoiceAmounts = group.invoiceAmounts || {};
        var invoiceInfo = {};

        var accountName = String(group.accountName || '');
        var itemSeqField = OPERATING_SEQ_FIELD;

        if (accountName.indexOf('- NAF - USD -') !== -1 || accountName.indexOf('- NAF - CAD -') !== -1) {
           itemSeqField = NAF_SEQ_FIELD;
        }

        log.audit('ACH Group Start', {
            key: group.key,
            accountName: accountName,
            itemSeqField: itemSeqField,
            batchId: group.batchId,
            customerId: group.customerId,
            accountId: group.accountId,
            payments: payments.length,
            failedPayments: group.failedPayments.length,
            availableAmount: group.totals.availableAmount
        });
      

        var invoiceIds = Object.keys(invoiceAmounts);
        var appliedTotal = invoiceIds.reduce(function (total, invoiceId) {
            return round(total + invoiceAmounts[invoiceId]);
        }, 0);

        log.audit('ACH Applied Invoices Loaded', {
            key: group.key,
            invoices: invoiceIds.length,
            batchAmount: group.totals.batchAmount,
            appliedInvoiceAmount: appliedTotal,
            difference: round(group.totals.batchAmount - appliedTotal)
        });

        if (!invoiceIds.length) {
            log.audit('ACH Group Skipped', 'No applied invoices found for ' + group.key);
            return;
        }

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
        var allocationDetails = [];

        invoiceIds.forEach(function (invoiceId) {
            var currentAmount = invoiceAmounts[invoiceId];
            var desiredAmount = Math.min(currentAmount, remaining);

            desiredAmount = round(desiredAmount);
            desiredByInvoice[invoiceId] = desiredAmount;
            remaining = round(remaining - desiredAmount);

            if (desiredAmount >= currentAmount - 0.009) allocation.full++;
            else if (desiredAmount > 0) allocation.partial++;
            else allocation.unpaid++;

            allocationDetails.push({
                invoiceId: invoiceId,
                invoiceNumber: invoiceInfo[invoiceId].invoiceNumber,
                invoiceDate: invoiceInfo[invoiceId].invoiceDate,
                itemSequence: invoiceInfo[invoiceId].itemSequence,
                currentAmount: currentAmount,
                desiredAmount: desiredAmount
            });
        });

        log.audit('ACH Allocation Built', {
            key: group.key,
            invoices: invoiceIds.length,
            full: allocation.full,
            partial: allocation.partial,
            unpaid: allocation.unpaid,
            unusedAmount: remaining
        });
        log.debug('ACH Allocation Detail', {
            key: group.key,
            detailsShown: Math.min(allocationDetails.length, 25),
            details: allocationDetails.slice(0, 25)
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

            log.debug('ACH Payment Edit Start', {
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

                if (invoiceAmounts[invoiceId] === undefined) {
                    hasOutsideApply = true;
                    outsideAmount = round(outsideAmount + currentAmount);
                    log.debug('ACH Apply Line Outside Group', {
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
                var allowedAmount = Math.min(currentAmount, desiredBefore);
                var lineChanged = false;

                allowedAmount = round(allowedAmount);
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

                log.debug('ACH Apply Line Decision', {
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
    log.debug('ACH Payment JE Needed', {
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
log.debug('ACH Payment Save Attempt', {
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
    returnJeId = createAndApplyPaymentJe(savedId, jeAmount);

    log.audit('ACH Return JE Applied', {
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

                log.audit('ACH Payment Updated', {
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
                log.debug('ACH Payment No Change', {
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

        log.audit('ACH Group Complete', {
            key: group.key,
            desiredLeftCount: desiredLeft.length,
            desiredLeft: desiredLeft.slice(0, 25)
        });
    }

    function runPaged(searchObj, callback) {
        var paged = searchObj.runPaged({ pageSize: 1000 });

        paged.pageRanges.forEach(function (range) {
            paged.fetch({ index: range.index }).data.forEach(callback);
        });
    }

    function parseCsv(text) {
        var rows = [];
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
                if (row.join('').trim()) rows.push(row);
                row = [];
                cell = '';
            } else {
                cell += c;
            }
        }

        if (cell || row.length) {
            row.push(cell);
            if (row.join('').trim()) rows.push(row);
        }

        var headers = (rows.shift() || []).map(function (header) {
            return String(header || '').replace(/^\uFEFF/, '').trim();
        });

        return rows.map(function (cols) {
            var obj = {};
            headers.forEach(function (header, index) {
                obj[header] = cols[index] || '';
            });
            return obj;
        });
    }

    function money(value) {
        return Number(String(value || '0').replace(/[$,]/g, '')) || 0;
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

  function createAndApplyPaymentJe(paymentId, jeAmount) {
    var paymentHeader = record.load({
        type: record.Type.CUSTOMER_PAYMENT,
        id: paymentId,
        isDynamic: false
    });

    var customerId = paymentHeader.getValue({ fieldId: 'customer' });
    var subsidiaryId = paymentHeader.getValue({ fieldId: 'subsidiary' });
    var currencyId = paymentHeader.getValue({ fieldId: 'currency' });
    var memoText = 'ACH Return Payment Offset';
    var mainInfo = {};
    var jeLineMap = {};
    var jeLines = [];
    var sourceDebitTotal = 0;
    var sourceCreditTotal = 0;

    runPaged(search.create({
        type: 'customerpayment',
        settings: [{ name: 'consolidationtype', value: 'ACCTTYPE' }],
        filters: [
            ['type', 'anyof', 'CustPymt'],
            'AND',
            ['internalid', 'anyof', paymentId]
        ],
        columns: [
            search.createColumn({ name: 'accountmain' }),
            search.createColumn({ name: 'account' }),
            search.createColumn({ name: 'entity' }),
            search.createColumn({ name: 'department' }),
            search.createColumn({ name: 'class' }),
            search.createColumn({ name: 'location' }),
            search.createColumn({ name: 'memo' }),
            search.createColumn({ name: 'debitamount' }),
            search.createColumn({ name: 'creditamount' })
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

        if (String(mainAccount) === String(lineAccount)) {
            mainInfo = {
                account: mainAccount,
                entity: entityId,
                department: departmentId,
                classId: classId,
                location: locationId,
                memo: result.getValue({ name: 'memo' })
            };
            return;
        }

        if (!lineAccount || (!debitAmount && !creditAmount)) return;

        var key = [
            lineAccount,
            entityId,
            departmentId || '',
            classId || '',
            locationId || '',
            debitAmount > 0 ? 'C' : 'D'
        ].join('|');

        if (!jeLineMap[key]) {
            jeLineMap[key] = {
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
            jeLines.push(jeLineMap[key]);
        }

        jeLineMap[key].sourceDebit = round(jeLineMap[key].sourceDebit + debitAmount);
        jeLineMap[key].sourceCredit = round(jeLineMap[key].sourceCredit + creditAmount);
        sourceDebitTotal = round(sourceDebitTotal + debitAmount);
        sourceCreditTotal = round(sourceCreditTotal + creditAmount);
    });

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

    log.debug('ACH Return JE Lines', {
        paymentId: paymentId,
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

    if (appliedJe) {
        applyPayment.save({ enableSourcing: false, ignoreMandatoryFields: true });
    } else {
        log.error('ACH Return JE Not Found On Payment Apply', {
            paymentId: paymentId,
            journalId: jeId,
            jeAmount: jeAmount
        });
    }

    return jeId;
}

    return {
        getInputData: getInputData,
        map: map
    };
});
