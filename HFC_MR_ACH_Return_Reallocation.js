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
            processCustomerPaymentGroup(data);
            context.write({ key: 'fileId', value: data.fileId });
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
        var customerRoots = {};
        var paymentHeaders = {};
        var batchIds = {};

        if (!failedRefs.length) return [];

        failedRefs.forEach(function (ref) {
            var failedPayment = record.load({
                type: record.Type.CUSTOMER_PAYMENT,
                id: customerFailedLookup[ref].paymentId,
                isDynamic: false
            });
            var batchId = failedPayment.getValue({ fieldId: BATCH_FIELD });
            if (!batchId) throw new Error('Failed Customer Payment ' + customerFailedLookup[ref].paymentId + ' has no PFA record.');
            batchIds[String(batchId)] = true;
        });

        runPaged(search.create({
            type: 'customerpayment',
            settings: [{ name: 'consolidationtype', value: 'ACCTTYPE' }],
            filters: [
                ['type', 'anyof', 'CustPymt'],
                'AND',
                // ['custbody_payment_process', 'is', 'T'],
                [BATCH_FIELD, 'anyof', Object.keys(batchIds)],
                'AND',
                ['trandate', 'within', 'daysago' + DAYS_BACK, 'daysago0'],
                'AND',
                ['appliedtotransaction.type', 'anyof', 'CustInvc']
            ],
            columns: [
                search.createColumn({ name: 'internalid', sort: search.Sort.ASC }),
                'tranid',
                'trandate',
                BATCH_FIELD,
                'entity',
                'account',
                'fxamount',
                'memo',
                search.createColumn({ name: 'appliedtotransaction', sort: search.Sort.ASC }),
                'appliedtoforeignamount'
            ]
        }), function (result) {
            var paymentId = String(result.getValue({ name: 'internalid' }));
            var ref = clean(result.getValue({ name: 'tranid' }));
            var batchId = result.getValue({ name: BATCH_FIELD });
            var customerId = result.getValue({ name: 'customer' });
            var accountId = result.getValue({ name: 'account' });
            var accountName = String(result.getText({ name: 'account' }) || '');
            var memo = String(result.getValue({ name: 'memo' }) || '');
            var paymentAmount = Math.abs(money(result.getValue({ name: 'fxamount' })));
            var invoiceId = result.getValue({ name: 'appliedtotransaction' });
            var appliedAmount = Math.abs(money(result.getValue({ name: 'appliedtoforeignamount' })));
            var failed = customerFailedLookup[ref];
            if (memo.indexOf(NEW_PAYMENT_MEMO_TEXT) !== -1) {
                throw new Error('Previously created reallocation payment ' + paymentId + ' exists in this PFA. Review before rerunning.');
            }

            if (!paymentId || !batchId || !customerId || !accountId || !paymentAmount || !invoiceId || !appliedAmount) return;

            if (!paymentHeaders[paymentId]) {
                var paymentRecord = record.load({ type: record.Type.CUSTOMER_PAYMENT, id: paymentId, isDynamic: false });
                paymentHeaders[paymentId] = {
                    currencyId: String(paymentRecord.getValue({ fieldId: 'currency' }) || ''),
                    subsidiaryId: String(paymentRecord.getValue({ fieldId: 'subsidiary' }) || ''),
                    arAccountId: String(paymentRecord.getValue({ fieldId: 'aracct' }) || '')
                };
                log.debug('Customer Payment Group Source', {
                    paymentId: paymentId,
                    paymentRef: ref,
                    batchId: batchId,
                    customerId: customerId,
                    accountId: accountId,
                    currencyId: paymentHeaders[paymentId].currencyId,
                    subsidiaryId: paymentHeaders[paymentId].subsidiaryId,
                    arAccountId: paymentHeaders[paymentId].arAccountId,
                    failed: !!failed
                });
            }
            var header = paymentHeaders[paymentId];
            if (!header.currencyId || !header.subsidiaryId || !header.arAccountId) {
                throw new Error('Missing currency, subsidiary, or A/R account on Customer Payment ' + paymentId);
            }
            var rootCustomerId = getRootCustomerId(customerId, customerRoots);
            var key = [batchId, rootCustomerId, accountId, header.currencyId, header.subsidiaryId, header.arAccountId].join('_');

            if (!groups[key]) {
                groups[key] = {
                    processType: PROCESS_CUSTOMER,
                    fileId: String(fileId),
                    fileName: fileName,
                    key: key,
                    batchId: String(batchId),
                    customerId: String(rootCustomerId),
                    accountId: String(accountId),
                    accountName: accountName,
                    currencyId: header.currencyId,
                    subsidiaryId: header.subsidiaryId,
                    arAccountId: header.arAccountId,
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
                    customerId: String(customerId),
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

            Object.keys(group.paymentMap).forEach(function (paymentId) {
                var payment = group.paymentMap[paymentId];
                var applied = payment.appliedInvoices.reduce(function (total, invoice) {
                    return round(total + invoice.appliedAmount);
                }, 0);
                if (Math.abs(applied - payment.amount) > 0.009) {
                    throw new Error('Payment ' + paymentId + ' has applied invoice total ' + applied +
                        ' but header amount ' + payment.amount + '. Manual review is required before reallocation.');
                }
            });

            group.totals.failedAmount = group.failedPayments.reduce(function (total, payment) {
                return round(total + money(payment.returnedAmount));
            }, 0);
            if (group.totals.failedAmount > group.totals.batchAmount + 0.009) {
                throw new Error('Returned amount exceeds batch payment amount for group ' + group.key);
            }
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

    function getRootCustomerId(customerId, cache) {
        var current = String(customerId);
        if (cache[current]) return cache[current];
        var parentId = String(record.load({ type: record.Type.CUSTOMER, id: current, isDynamic: false })
            .getValue({ fieldId: 'parent' }) || '');
        var searchParent = search.lookupFields({ type: search.Type.CUSTOMER, id: current, columns: ['parent'] }).parent || [];
        log.debug('Customer Parent Lookup', { customerId: current, recordParentId: parentId, searchParent: searchParent });
        if (parentId === current) throw new Error('Customer ' + current + ' is its own parent.');
        var root = parentId || current;
        cache[current] = root;
        log.debug('Customer Hierarchy Resolved', { customerId: current, rootCustomerId: root });
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
        var desiredByInvoice = {};
        var payments = group.passedPayments.concat(group.failedPayments).sort(function (a, b) {
            return dateTime(a.paymentDate) - dateTime(b.paymentDate) ||
                String(a.paymentRef).localeCompare(String(b.paymentRef)) ||
                Number(a.paymentId) - Number(b.paymentId);
        });

        Object.keys(group.desiredByInvoice || {}).forEach(function (invoiceId) {
            desiredByInvoice[invoiceId] = group.desiredByInvoice[invoiceId];
        });

        var jeTotal = 0;
        var newPaymentTotal = 0;
        var plannedNewByCustomer = {};
        var projectedDesired = 0;

        Object.keys(desiredByInvoice).forEach(function (invoiceId) {
            var desired = desiredByInvoice[invoiceId];
            var kept = round(Math.min(desired, group.invoiceAmounts[invoiceId] || 0));
            var newAmount = round(desired - kept);
            projectedDesired = round(projectedDesired + desired);
            if (newAmount <= 0.009) return;
            var customerId = group.invoiceInfo[invoiceId].customerId;
            if (!plannedNewByCustomer[customerId]) plannedNewByCustomer[customerId] = [];
            plannedNewByCustomer[customerId].push({ invoiceId: invoiceId, amount: newAmount });
        });

        if (Math.abs(round(group.totals.batchAmount - projectedDesired) - group.totals.failedAmount) > 0.009) {
            throw new Error('Customer group ' + group.key + ' does not balance before edits.');
        }

        var projectedJournals = 0;
        var remainingDesired = {};
        Object.keys(desiredByInvoice).forEach(function (invoiceId) {
            remainingDesired[invoiceId] = desiredByInvoice[invoiceId];
        });
        payments.forEach(function (payment) {
            payment.appliedInvoices.forEach(function (entry) {
                var retained = round(Math.min(entry.appliedAmount, remainingDesired[entry.invoiceId] || 0));
                remainingDesired[entry.invoiceId] = round((remainingDesired[entry.invoiceId] || 0) - retained);
                if (entry.appliedAmount - retained > 0.009) projectedJournals++;
            });
        });
        var estimatedUsage = payments.length * 50 + projectedJournals * 90 +
            Object.keys(plannedNewByCustomer).length * 50 + 100;
        if (estimatedUsage > runtime.getCurrentScript().getRemainingUsage()) {
            throw new Error('Customer group ' + group.key + ' needs approximately ' + estimatedUsage +
                ' map usage units for ' + projectedJournals + ' invoice JEs; split this group before processing.');
        }

        Object.keys(plannedNewByCustomer).forEach(function (customerId) {
            createReallocationPayment(group, customerId, plannedNewByCustomer[customerId], payments[0], false);
        });

        var paymentRecords = {};
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
            if (Math.abs(money(paymentRecord.getValue({ fieldId: 'payment' })) - payment.amount) > 0.009) {
                throw new Error('Customer Payment ' + payment.paymentId + ' amount changed after input preparation.');
            }
            for (var line = 0; line < paymentRecord.getLineCount({ sublistId: 'apply' }); line++) {
                if (!paymentRecord.getSublistValue({ sublistId: 'apply', fieldId: 'apply', line: line })) continue;
                var invoiceId = String(paymentRecord.getSublistValue({ sublistId: 'apply', fieldId: 'doc', line: line }) || '');
                var currentAmount = money(paymentRecord.getSublistValue({ sublistId: 'apply', fieldId: 'amount', line: line }));
                if (!expected[invoiceId] || expected[invoiceId] + 0.009 < currentAmount) {
                    throw new Error('Customer Payment ' + payment.paymentId + ' applications changed after input preparation.');
                }
                expected[invoiceId] = round(expected[invoiceId] - currentAmount);
                if (expected[invoiceId] <= 0.009) delete expected[invoiceId];
            }
            if (Object.keys(expected).length) {
                throw new Error('Customer Payment ' + payment.paymentId + ' is missing expected invoice applications.');
            }
            paymentRecords[payment.paymentId] = paymentRecord;
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
            var paymentRecord = paymentRecords[payment.paymentId];
            var lineCount = paymentRecord.getLineCount({ sublistId: 'apply' });
            var bodyPaymentBefore = money(paymentRecord.getValue({ fieldId: 'payment' }));
            var changed = false;
            var hadGroupApply = false;
            var keptGroupAmount = 0;
            var removed = [];

            log.debug('Customer Payment Edit Start', {
                paymentId: payment.paymentId,
                paymentRef: payment.paymentRef,
                bodyPaymentBefore: bodyPaymentBefore,
                lineCount: lineCount
            });

            for (var i = 0; i < lineCount; i++) {
                var applied = paymentRecord.getSublistValue({ sublistId: 'apply', fieldId: 'apply', line: i });
                var invoiceId = paymentRecord.getSublistValue({ sublistId: 'apply', fieldId: 'doc', line: i });
                var currentAmount = money(paymentRecord.getSublistValue({ sublistId: 'apply', fieldId: 'amount', line: i }));

                if (!applied || !invoiceId || currentAmount <= 0) continue;

                invoiceId = String(invoiceId);

                if ((group.invoiceAmounts || {})[invoiceId] === undefined) {
                    throw new Error('Unexpected applied transaction ' + invoiceId + ' on Customer Payment ' + payment.paymentId);
                }

                hadGroupApply = true;

                var desiredBefore = desiredByInvoice[invoiceId] || 0;
                var allowedAmount = round(Math.min(currentAmount, desiredBefore));
                var lineChanged = false;

                desiredByInvoice[invoiceId] = round((desiredByInvoice[invoiceId] || 0) - allowedAmount);
                keptGroupAmount = round(keptGroupAmount + allowedAmount);
                if (currentAmount - allowedAmount > 0.009) {
                    removed.push({ invoiceId: invoiceId, amount: round(currentAmount - allowedAmount) });
                }

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

            var removedTotal = removed.reduce(function (total, entry) { return round(total + entry.amount); }, 0);
            if (Math.abs(bodyPaymentBefore - keptGroupAmount - removedTotal) > 0.009) {
                throw new Error('Customer Payment ' + payment.paymentId + ' does not reconcile before JE creation.');
            }

            if (hadGroupApply && keptGroupAmount <= 0) {
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
                    keptGroupAmount: keptGroupAmount,
                    removed: removed
                });

                var savedId = paymentRecord.save({ enableSourcing: false, ignoreMandatoryFields: true });

                removed.forEach(function (entry) {
                    var journalId = createCustomerPaymentJeAndApply(savedId, entry.amount, payment.paymentRef, entry.invoiceId);
                    jeTotal = round(jeTotal + entry.amount);
                    log.audit('Customer Invoice JE Applied', {
                        paymentId: savedId,
                        paymentRef: payment.paymentRef,
                        invoiceId: entry.invoiceId,
                        journalId: journalId,
                        jeAmount: entry.amount
                    });
                });

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

                if (Math.abs(money(savedRecord.getValue({ fieldId: 'payment' })) - bodyPaymentBefore) > 0.009) {
                    throw new Error('Customer Payment ' + savedId + ' header amount changed unexpectedly.');
                }

                log.audit('Customer Payment Updated', {
                    paymentId: payment.paymentId,
                    paymentRef: payment.paymentRef,
                    keptAmount: keptGroupAmount,
                    bodyPaymentBefore: bodyPaymentBefore,
                    savedBodyPayment: money(savedRecord.getValue({ fieldId: 'payment' })),
                    savedAppliedAmount: savedApplied,
                    jeCount: removed.length,
                    memoVoided: hadGroupApply && keptGroupAmount <= 0
                });
            } else {
                log.debug('Customer Payment No Change', {
                    paymentId: payment.paymentId,
                    paymentRef: payment.paymentRef,
                    bodyPaymentBefore: bodyPaymentBefore,
                    keptGroupAmount: keptGroupAmount
                });
            }
        });

        var newByCustomer = {};
        Object.keys(desiredByInvoice).forEach(function (invoiceId) {
            var amount = round(desiredByInvoice[invoiceId]);
            if (amount <= 0.009) return;
            var customerId = group.invoiceInfo[invoiceId].customerId;
            if (!newByCustomer[customerId]) newByCustomer[customerId] = [];
            newByCustomer[customerId].push({ invoiceId: invoiceId, amount: amount });
        });

        Object.keys(newByCustomer).forEach(function (customerId) {
            var newPaymentId = createReallocationPayment(group, customerId, newByCustomer[customerId], payments[0], true);
            var amount = newByCustomer[customerId].reduce(function (total, entry) {
                return round(total + entry.amount);
            }, 0);
            newPaymentTotal = round(newPaymentTotal + amount);
            log.audit('Customer Reallocation Payment Created', {
                key: group.key,
                customerId: customerId,
                paymentId: newPaymentId,
                amount: amount,
                invoices: newByCustomer[customerId]
            });
        });

        if (Math.abs(round(jeTotal - newPaymentTotal) - group.totals.failedAmount) > 0.009) {
            throw new Error('Group ' + group.key + ' does not reconcile: JE ' + jeTotal +
                ', new payments ' + newPaymentTotal + ', failed ' + group.totals.failedAmount);
        }

        log.audit('Customer Group Complete', {
            key: group.key,
            journalsAmount: jeTotal,
            newPaymentsAmount: newPaymentTotal,
            failedAmount: group.totals.failedAmount
        });
    }

    function createReallocationPayment(group, customerId, invoices, sourcePayment, saveRecord) {
        var amount = invoices.reduce(function (total, entry) { return round(total + entry.amount); }, 0);
        var paymentRecord = record.transform({
            fromType: record.Type.CUSTOMER,
            fromId: customerId,
            toType: record.Type.CUSTOMER_PAYMENT,
            isDynamic: false
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
        paymentRecord.setValue({ fieldId: 'payment', value: amount });
        paymentRecord.setValue({ fieldId: 'memo', value: NEW_PAYMENT_MEMO_TEXT + ' | PFA ' + group.batchId +
            ' | Source Payment ' + sourcePayment.paymentId });

        var needed = {};
        invoices.forEach(function (entry) { needed[entry.invoiceId] = entry.amount; });
        var lineCount = paymentRecord.getLineCount({ sublistId: 'apply' });

        for (var i = 0; i < lineCount; i++) {
            var invoiceId = String(paymentRecord.getSublistValue({ sublistId: 'apply', fieldId: 'doc', line: i }) || '');
            if (!needed[invoiceId]) {
                if (paymentRecord.getSublistValue({ sublistId: 'apply', fieldId: 'apply', line: i })) {
                    paymentRecord.setSublistValue({ sublistId: 'apply', fieldId: 'apply', line: i, value: false });
                }
                continue;
            }
            paymentRecord.setSublistValue({ sublistId: 'apply', fieldId: 'apply', line: i, value: true });
            paymentRecord.setSublistValue({ sublistId: 'apply', fieldId: 'amount', line: i, value: needed[invoiceId] });
            delete needed[invoiceId];
        }

        if (Object.keys(needed).length) {
            throw new Error('Invoices ' + Object.keys(needed).join(', ') +
                ' were not available on transformed Customer Payment for customer ' + customerId);
        }

        return saveRecord ? paymentRecord.save({ enableSourcing: false, ignoreMandatoryFields: false }) : null;
    }

    function createCustomerPaymentJeAndApply(paymentId, jeAmount, paymentRef, invoiceId) {
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
        jeRecord.setValue({ fieldId: JE_INVOICE_FIELD, value: invoiceId });

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
        summarize: summarize
    };
});
