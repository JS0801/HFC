/**
 * @NApiVersion 2.x
 * @NScriptType MapReduceScript
 *
 * NSF Payment Reversal — v2 DRY RUN
 *
 * !! SAFE TO RUN IN LIVE — ZERO WRITES !!
 * Every record.save(), file.save(), record.create() is commented out.
 * All decisions are logged in detail so you can verify logic before going live.
 *
 * Script Parameters:
 *   custscript_nsf_fileid  (optional) — pass a specific file ID to override folder search
 *   custscript_nsf_dryrun  — always true in this version (hardcoded)
 *
 * LOG STRUCTURE:
 *   [DRYRUN] tags mark every action that would normally write to NetSuite
 *   [DATA]   tags show raw data being read
 *   [SORT]   tags show invoice ordering
 *   [CALC]   tags show NSF math at each step
 *   [RESULT] tags show what WOULD happen per payment
 */

define([
    'N/file', 'N/search', 'N/runtime', 'N/record', 'N/error', 'N/format'
],
function (file, search, runtime, record, error, format) {

    var DRY_RUN = true; // hardcoded — flip to false only in the real version

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 1: getInputData
    // ─────────────────────────────────────────────────────────────────────────
    function getInputData() {

        log.audit('=== DRY RUN MODE ACTIVE — NO RECORDS WILL BE SAVED ===', 'Safe to run in Live');

        // --- Find the NSF CSV file ---
        var file_id;
        var paramFileId = runtime.getCurrentScript().getParameter('custscript_nsf_fileid');

        if (!isNullOrEmpty(paramFileId)) {
            file_id = paramFileId;
            log.debug('[DATA] File ID from script parameter', file_id);
        } else {
            var fileSearch = search.create({
                type:    'file',
                filters: [['folder', 'anyof', '329224']],
                columns: [search.createColumn({ name: 'internalid' })]
            });
            var fileCount = fileSearch.runPaged().count;
            log.debug('[DATA] Inbox folder file count', fileCount);

            if (fileCount === 0) {
                log.debug('[DATA] getInputData', 'No file in inbox folder. Nothing to process.');
                return [];
            }
            fileSearch.run().each(function (result) {
                file_id = 12497592 //result.getValue({ name: 'internalid' });
                return true;
            });
            log.debug('[DATA] File ID found in inbox folder', file_id);
        }

        // --- Load file and check for duplicate ---
        var csvFile = file.load({ id: file_id });
        var fileName = csvFile.name;
        log.debug('[DATA] File name', fileName);

        var dupSearch = search.create({
            type:    'file',
            filters: [['name', 'is', fileName], 'AND', ['folder', 'anyof', '32933225']],
            columns: [search.createColumn({ name: 'internalid' })]
        });
        if (dupSearch.runPaged().count > 0) {
            log.debug('[DRYRUN] WOULD move file to duplicate folder (398330)', fileName + ' already exists in processed folder');
            // DRYRUN: csvFile.folder = 398330; csvFile.save();
            return [];
        }

        // --- Parse CSV ---
        var arrLines = csvFile.getContents().split(/\r?\n/);
        for (var i = arrLines.length - 1; i >= 0; i--) {
            if (isNullOrEmpty(arrLines[i].trim())) arrLines.splice(i, 1);
        }

        log.debug('[DATA] CSV rows after cleaning (including header)', arrLines.length);

        var nsfPayments = [];

        for (var y = 1; y < arrLines.length; y++) {
            var cols     = splitCSVLine(arrLines[y]);
            var seqNum   = (cols[24] || '').trim();
            var addenda  = (cols[25] || '').trim();

            if (seqNum === '2' && addenda.indexOf('TRANSACTION REFERENCE:') !== -1) {
                var pymtNumber = addenda.replace('TRANSACTION REFERENCE:', '').trim();

                var prevCols   = y > 0 ? splitCSVLine(arrLines[y - 1]) : [];
                var prevSeq    = (prevCols[24] || '').trim();
                var prevReturn = (prevCols[7]  || '').trim();
                var prevCcy    = (prevCols[8]  || '').trim();
                var prevAmt    = parseFloat((prevCols[10] || '0').replace(/[^0-9.-]/g, '')) || 0;

                log.debug('[DATA] Row ' + y + ' — Sequence #2 found', 
                    'PYMT: ' + pymtNumber + 
                    ' | Prev row Seq: ' + prevSeq + 
                    ' | Prev Return Desc: ' + prevReturn + 
                    ' | Currency: ' + prevCcy + 
                    ' | Amount: ' + prevAmt);

                if (prevSeq === '1' && prevReturn === 'Return') {
                    nsfPayments.push({
                        pymtNumber: pymtNumber,
                        currency:   prevCcy,
                        nsfAmount:  prevAmt,
                        fileId:     file_id
                    });
                    log.debug('[DATA] NSF payment accepted', 
                        pymtNumber + ' | ' + prevCcy + ' | $' + prevAmt);
                } else {
                    log.debug('[DATA] Row skipped — prev row not a Return Seq#1', 
                        'prevSeq: ' + prevSeq + ' | prevReturn: ' + prevReturn);
                }
            }
        }

        log.audit('[DATA] Total NSF payments parsed from CSV', nsfPayments.length);
        if (nsfPayments.length === 0) {
            log.debug('[DATA] No NSF payments found in file. Exiting.');
            return [];
        }

        // --- Look up each PYMT in NetSuite ---
        var groups = {};

        for (var p = 0; p < nsfPayments.length; p++) {
            var nsf = nsfPayments[p];
            log.debug('[DATA] Looking up payment in NetSuite', nsf.pymtNumber);

            var pmtSearch = search.create({
                type:    'transaction',
                filters: [
                    ['numbertext', 'is', nsf.pymtNumber],
                    'AND',
                    ['mainline', 'is', 'T']
                ],
                columns: [
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: 'entity' }),
                    search.createColumn({ name: 'custbody_9997_pfa_record' }),
                    search.createColumn({ name: 'subsidiary' }),
                    search.createColumn({ name: 'fxamount' })
                ]
            });

            var found = false;
            pmtSearch.run().each(function (result) {
                found = true;
                var pmtId      = result.getValue({ name: 'internalid' });
                var customerId = result.getValue({ name: 'entity' });
                var pfaId      = result.getValue({ name: 'custbody_9997_pfa_record' });
                var subsidiary = result.getValue({ name: 'subsidiary' });
                var amount     = parseFloat(result.getValue({ name: 'fxamount' })) || nsf.nsfAmount;

                log.debug('[DATA] Payment found', 
                    'PYMT: ' + nsf.pymtNumber + 
                    ' | Internal ID: ' + pmtId + 
                    ' | Customer ID: ' + customerId + 
                    ' | PFA ID: ' + pfaId + 
                    ' | Subsidiary: ' + subsidiary + 
                    ' | Amount: ' + amount);

                if (isNullOrEmpty(pfaId)) {
                    log.error('[DATA] NO PFA record on payment — will skip', 
                        nsf.pymtNumber + ' (id: ' + pmtId + ')');
                    return true;
                }

                var groupKey = pfaId + '|' + customerId;
                if (!groups[groupKey]) {
                    groups[groupKey] = {
                        pfaId:       pfaId,
                        customerId:  customerId,
                        subsidiary:  subsidiary,
                        currency:    nsf.currency,
                        fileId:      nsf.fileId,
                        nsfPayments: []
                    };
                    log.debug('[DATA] New group created', 
                        'Key: ' + groupKey + ' | PFA: ' + pfaId + ' | Customer: ' + customerId);
                }

                groups[groupKey].nsfPayments.push({
                    pymtNumber: nsf.pymtNumber,
                    pmtId:      pmtId,
                    nsfAmount:  amount
                });

                return true;
            });

            if (!found) {
                log.error('[DATA] Payment NOT found in NetSuite', nsf.pymtNumber);
            }
        }

        // --- Summary of groups ---
        var result = [];
        for (var key in groups) {
            if (groups.hasOwnProperty(key)) {
                var g = groups[key];
                log.audit('[DATA] Group summary', 
                    'Key: ' + key + 
                    ' | PFA: ' + g.pfaId + 
                    ' | Customer: ' + g.customerId + 
                    ' | NSF payments in group: ' + g.nsfPayments.length + 
                    ' | Total NSF: $' + g.nsfPayments.reduce(function(sum, p) { return sum + p.nsfAmount; }, 0));
                result.push(g);
            }
        }

        log.audit('[DATA] Total PFA+Customer groups to process', result.length);
        return result;
    }


    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 2: reduce
    // ─────────────────────────────────────────────────────────────────────────
    function reduce(context) {
        try {
            var groupData   = JSON.parse(context.values[0]);
            var pfaId       = groupData.pfaId;
            var customerId  = groupData.customerId;
            var subsidiary  = groupData.subsidiary;
            var currency    = groupData.currency;
            var fileId      = groupData.fileId;
            var nsfPayments = groupData.nsfPayments;
            var currencyId  = (currency === 'CAD') ? 3 : 1;

            log.audit('========================================', 
                'REDUCE START | PFA: ' + pfaId + ' | Customer: ' + customerId + ' | Currency: ' + currency);

            // ── Step 1: Load PFA, parse all payment IDs ────────────────────────
            log.debug('[DATA] Loading PFA record', pfaId);
            var pfaRecord  = record.load({ type: 'customrecord_2663_file_admin', id: parseInt(pfaId) });
            var hashString = pfaRecord.getValue({ fieldId: 'custrecord_2663_fm_trans_hash_string' });

            log.debug('[DATA] PFA hash string length (chars)', hashString ? hashString.length : 0);

            var allPfaPaymentIds = parseHashStringKeys(hashString);
            log.audit('[DATA] Total payment IDs on PFA (all customers)', allPfaPaymentIds.length);
            log.debug('[DATA] All PFA payment IDs', allPfaPaymentIds.join(', '));

            // ── Step 2: Filter to this customer, get invoice per payment ────────
            var customerPayments = [];

            for (var i = 0; i < allPfaPaymentIds.length; i++) {
                var pmtId = allPfaPaymentIds[i];

                var pmtSearch = search.create({
                    type:    'transaction',
                    filters: [
                        ['internalid', 'anyof', pmtId],
                        'AND',
                        ['entity',     'anyof', customerId],
                        'AND',
                        ['mainline',   'is',    'T']
                    ],
                    columns: [
                        search.createColumn({ name: 'internalid' }),
                        search.createColumn({ name: 'fxamount' }),
                        search.createColumn({ name: 'entity' })
                    ]
                });

                var pmtResult = null;
                pmtSearch.run().each(function (result) {
                    pmtResult = {
                        pmtId:     result.getValue({ name: 'internalid' }),
                        pmtAmount: parseFloat(result.getValue({ name: 'fxamount' })) || 0
                    };
                    return true;
                });

                if (!pmtResult) continue; // different customer — skip

                log.debug('[DATA] Customer payment found on PFA', 
                    'Payment ID: ' + pmtResult.pmtId + ' | Amount: ' + pmtResult.pmtAmount);

                // Get the invoice applied to this payment
                // Load the payment record and read the apply sublist directly —
                // more reliable than applyingtransaction search filter
                var invoiceResult = null;
                try {
                    var pmtRecordTemp = record.load({
                        type: record.Type.CUSTOMER_PAYMENT,
                        id:   parseInt(pmtResult.pmtId)
                    });
                    var applyCount = pmtRecordTemp.getLineCount({ sublistId: 'apply' });
                    log.debug('[DATA] Apply sublist lines for payment ' + pmtResult.pmtId, applyCount);

                    for (var a = 0; a < applyCount; a++) {
                        var isApplied = pmtRecordTemp.getSublistValue({ sublistId: 'apply', fieldId: 'apply',      line: a });
                        var applyType = pmtRecordTemp.getSublistValue({ sublistId: 'apply', fieldId: 'type',       line: a });
                        var applyId   = pmtRecordTemp.getSublistValue({ sublistId: 'apply', fieldId: 'internalid', line: a });
                        var applyAmt  = pmtRecordTemp.getSublistValue({ sublistId: 'apply', fieldId: 'amount',     line: a });

                        log.debug('[DATA] Apply line ' + a, 
                            'Type: ' + applyType + ' | Applied: ' + isApplied + 
                            ' | ID: ' + applyId  + ' | Amount: ' + applyAmt);

                        if (isApplied && applyType === 'Invoice') {
                            // Look up invoice date separately
                            var invSearch = search.create({
                                type:    'transaction',
                                filters: [['internalid', 'anyof', applyId], 'AND', ['mainline', 'is', 'T']],
                                columns: [
                                    search.createColumn({ name: 'trandate' }),
                                    search.createColumn({ name: 'tranid' }),
                                    search.createColumn({ name: 'fxamount' })
                                ]
                            });
                            invSearch.run().each(function (invResult) {
                                invoiceResult = {
                                    invoiceId:     applyId,
                                    invoiceNum:    invResult.getValue({ name: 'tranid' }),
                                    invoiceDate:   invResult.getValue({ name: 'trandate' }),
                                    invoiceAmount: parseFloat(applyAmt) || parseFloat(invResult.getValue({ name: 'fxamount' })) || 0
                                };
                                return true;
                            });
                            break; // only one invoice per payment per business rule
                        }
                    }
                } catch (loadErr) {
                    log.error('[DATA] Could not load payment record ' + pmtResult.pmtId, loadErr.message);
                }

                if (!invoiceResult) {
                    log.debug('[DATA] No invoice found for payment — skipping', pmtResult.pmtId);
                    continue;
                }

                log.debug('[DATA] Invoice linked to payment', 
                    'Payment: ' + pmtResult.pmtId + 
                    ' → Invoice: ' + invoiceResult.invoiceNum + 
                    ' (ID: ' + invoiceResult.invoiceId + ')' +
                    ' | Date: ' + invoiceResult.invoiceDate + 
                    ' | Amount: $' + invoiceResult.invoiceAmount);

                customerPayments.push({
                    pmtId:         pmtResult.pmtId,
                    pmtAmount:     pmtResult.pmtAmount,
                    invoiceId:     invoiceResult.invoiceId,
                    invoiceNum:    invoiceResult.invoiceNum,
                    invoiceDate:   invoiceResult.invoiceDate,
                    invoiceAmount: invoiceResult.invoiceAmount
                });
            }

            log.audit('[DATA] Customer payments found on PFA for this customer', customerPayments.length);

            if (customerPayments.length === 0) {
                log.error('[DATA] No customer payments matched — check entity filter', 
                    'Customer: ' + customerId + ' | PFA: ' + pfaId);
                return;
            }

            // ── Step 3: Sort oldest → newest ──────────────────────────────────
            customerPayments.sort(function (a, b) {
                return parseDateMMDDYYYY(a.invoiceDate) - parseDateMMDDYYYY(b.invoiceDate);
            });

            log.audit('[SORT] Invoice order after sorting oldest → newest', '');
            for (var s = 0; s < customerPayments.length; s++) {
                var p = customerPayments[s];
                log.debug('[SORT] Position ' + (s + 1), 
                    'Invoice: ' + p.invoiceNum + 
                    ' | Date: ' + p.invoiceDate + 
                    ' | Amount: $' + p.invoiceAmount + 
                    ' | Payment ID: ' + p.pmtId);
            }

            // ── Step 4: Calculate total NSF ────────────────────────────────────
            var nsfRemaining = 0;
            log.audit('[CALC] NSF payments in this group', '');
            for (var n = 0; n < nsfPayments.length; n++) {
                nsfRemaining += nsfPayments[n].nsfAmount;
                log.debug('[CALC] NSF payment', 
                    nsfPayments[n].pymtNumber + 
                    ' | Amount: $' + nsfPayments[n].nsfAmount + 
                    ' | Running total: $' + nsfRemaining);
            }
            log.audit('[CALC] Total NSF amount for this customer/PFA group', '$' + nsfRemaining);

            // ── Step 5: Walk oldest → newest, determine what gets reversed ──────
            log.audit('[RESULT] ===== WHAT WOULD HAPPEN =====', 
                'Customer: ' + customerId + ' | PFA: ' + pfaId);

            var nsfRemainingStart = nsfRemaining;
            var curDate = formatDate();

            for (var j = 0; j < customerPayments.length; j++) {
                if (nsfRemaining <= 0) {
                    log.audit('[RESULT] NSF fully consumed — remaining payments STAY INTACT', 
                        'From position ' + (j + 1) + ' onward (' + (customerPayments.length - j) + ' payments untouched)');
                    break;
                }

                var pmt = customerPayments[j];
                var isFullReversal = pmt.invoiceAmount <= nsfRemaining;
                var jeAmount       = isFullReversal ? pmt.invoiceAmount : nsfRemaining;
                var reApplyAmount  = isFullReversal ? 0 : (pmt.invoiceAmount - nsfRemaining);

                // Get accounts (read-only — safe in dry run)
                var accounts      = getPaymentAccounts(pmt.pmtId);
                var creditAccount = accounts.creditAccount;
                var debitAccount  = accounts.debitAccount;

                if (isFullReversal) {
                    log.audit('[RESULT] FULL REVERSAL', 
                        'Position: ' + (j + 1) + 
                        ' | Invoice: ' + pmt.invoiceNum + 
                        ' (' + pmt.invoiceDate + ')' +
                        ' | Invoice Amount: $' + pmt.invoiceAmount + 
                        ' | Payment ID: ' + pmt.pmtId +
                        ' | JE Amount: $' + jeAmount +
                        ' | NSF before: $' + nsfRemaining + 
                        ' | NSF after: $' + (nsfRemaining - pmt.invoiceAmount));
                    log.debug('[RESULT] Accounts for JE', 
                        'Credit (AR): ' + creditAccount + ' | Debit (Bank): ' + debitAccount);
                    log.debug('[DRYRUN] WOULD create JE: $' + jeAmount + ' | subsidiary: ' + subsidiary + ' | currency: ' + currencyId);
                    log.debug('[DRYRUN] WOULD unapply payment ' + pmt.pmtId + ' from invoice ' + pmt.invoiceId);
                    log.debug('[DRYRUN] WOULD apply JE to payment ' + pmt.pmtId);
                    log.debug('[DRYRUN] WOULD set custbody_datetimeunapplied on payment ' + pmt.pmtId);

                    nsfRemaining -= pmt.invoiceAmount;

                } else {
                    log.audit('[RESULT] PARTIAL REVERSAL', 
                        'Position: ' + (j + 1) + 
                        ' | Invoice: ' + pmt.invoiceNum + 
                        ' (' + pmt.invoiceDate + ')' +
                        ' | Invoice Amount: $' + pmt.invoiceAmount +
                        ' | Payment ID: ' + pmt.pmtId +
                        ' | NSF portion (JE): $' + jeAmount + 
                        ' | Collected portion (re-apply): $' + reApplyAmount +
                        ' | Invoice stays OPEN for: $' + jeAmount);
                    log.debug('[RESULT] Accounts for JE', 
                        'Credit (AR): ' + creditAccount + ' | Debit (Bank): ' + debitAccount);
                    log.debug('[DRYRUN] WOULD create JE: $' + jeAmount + ' (standalone — NOT applied to payment)');
                    log.debug('[DRYRUN] WOULD unapply payment ' + pmt.pmtId + ' from invoice ' + pmt.invoiceId);
                    log.debug('[DRYRUN] WOULD re-apply payment ' + pmt.pmtId + ' to invoice ' + pmt.invoiceId + ' for $' + reApplyAmount);
                    log.debug('[DRYRUN] Invoice ' + pmt.invoiceNum + ' will remain open for $' + jeAmount);
                    log.debug('[DRYRUN] WOULD set custbody_datetimeunapplied on payment ' + pmt.pmtId);

                    nsfRemaining = 0;
                }
            }

            // Log payments that would NOT be touched
            var firstUntouchedIdx = -1;
            var nsfCheck = nsfRemainingStart;
            for (var k = 0; k < customerPayments.length; k++) {
                if (nsfCheck <= 0) { firstUntouchedIdx = k; break; }
                nsfCheck -= customerPayments[k].invoiceAmount;
            }
            if (firstUntouchedIdx >= 0) {
                log.audit('[RESULT] Payments STAYING INTACT (oldest invoices paid, no reversal needed)', '');
                for (var m = firstUntouchedIdx; m < customerPayments.length; m++) {
                    log.debug('[RESULT] NO ACTION on payment', 
                        'Position: ' + (m + 1) + 
                        ' | Invoice: ' + customerPayments[m].invoiceNum + 
                        ' (' + customerPayments[m].invoiceDate + ')' +
                        ' | Amount: $' + customerPayments[m].invoiceAmount + 
                        ' | Payment ID: ' + customerPayments[m].pmtId);
                }
            }

            // ── File update (dry run — no save) ───────────────────────────────
            log.debug('[DRYRUN] WOULD mark file description as Pending | File ID: ' + fileId);

            log.audit('========================================', 
                'REDUCE END | PFA: ' + pfaId + ' | Customer: ' + customerId);

        } catch (e) {
            log.error({
                title:   '[DRYRUN] reduce error — ' + e.name,
                details: 'PFA: ' + (context.values[0] ? JSON.parse(context.values[0]).pfaId : 'unknown') +
                         ' | Customer: ' + (context.values[0] ? JSON.parse(context.values[0]).customerId : 'unknown') +
                         ' | ' + e.message + ' | Stack: ' + e.stack
            });
            throw e;
        }
    }


    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 3: summarize
    // ─────────────────────────────────────────────────────────────────────────
    function summarize(summary) {
        log.audit('=== DRY RUN COMPLETE — NO RECORDS WERE SAVED ===', 
            'Review the audit/debug logs above to verify the logic before running the live version.');

        var errorCount = 0;
        summary.reduceSummary.errors.iterator().each(function (key, err) {
            log.error({ title: '[DRYRUN] Reduce error for key ' + key, details: err });
            errorCount++;
            return true;
        });

        if (errorCount === 0) {
            log.audit('[DRYRUN] summarize', 'All groups processed without errors. ' +
                'WOULD move file to processed folder (329225) and mark Completed.');
        } else {
            log.audit('[DRYRUN] summarize', errorCount + ' error(s) occurred. ' +
                'File would NOT be moved. Review errors above.');
        }

        // Usage stats
        log.debug('[DRYRUN] Script usage', 
            'Units used: ' + summary.usage + 
            ' | Concurrency: ' + summary.concurrency + 
            ' | Yields: ' + summary.yields);
    }


    // ─────────────────────────────────────────────────────────────────────────
    // HELPERS (identical to live version — all read-only)
    // ─────────────────────────────────────────────────────────────────────────

    function parseHashStringKeys(hashString) {
        var ids = [];
        if (isNullOrEmpty(hashString)) return ids;
        try {
            var cleaned = hashString
                .replace(/:\[tx\[\d+\]\]/g, ':1')
                .replace(/:\[tx\[\d+\],tx\[\d+\]\]/g, ':1');
            var parsed = JSON.parse(cleaned);
            for (var key in parsed) {
                if (parsed.hasOwnProperty(key)) ids.push(key);
            }
        } catch (e) {
            log.debug('[DATA] parseHashStringKeys — JSON parse failed, using regex fallback', e.message);
            var re = /"(\d+)":/g;
            var match;
            while ((match = re.exec(hashString)) !== null) ids.push(match[1]);
        }
        log.debug('[DATA] parseHashStringKeys result', ids.length + ' IDs extracted');
        return ids;
    }

    function getPaymentAccounts(pmtId) {
        var creditAccount;
        var debitAccount;

        var lineSearch = search.create({
            type:     'transaction',
            settings: [{ name: 'consolidationtype', value: 'ACCTTYPE' }],
            filters:  [['internalid', 'anyof', pmtId]],
            columns:  [
                search.createColumn({ name: 'account' }),
                search.createColumn({ name: 'creditfxamount' }),
                search.createColumn({ name: 'debitfxamount' })
            ]
        });

        lineSearch.run().each(function (result) {
            var credit = result.getValue({ name: 'creditfxamount' });
            var debit  = result.getValue({ name: 'debitfxamount' });
            var acct   = result.getValue({ name: 'account' });
            if (!isNullOrEmpty(debit)  && parseFloat(debit)  > 0) debitAccount  = acct;
            if (!isNullOrEmpty(credit) && parseFloat(credit) > 0) creditAccount = acct;
            return true;
        });

        return { creditAccount: creditAccount, debitAccount: debitAccount };
    }

    function parseDateMMDDYYYY(dateStr) {
        if (!dateStr) return new Date(0);
        var parts = dateStr.split('/');
        if (parts.length !== 3) return new Date(0);
        return new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
    }

    function formatDate() {
        var d  = new Date();
        var mm = d.getMonth() + 1;
        var dd = d.getDate();
        if (mm < 10) mm = '0' + mm;
        if (dd < 10) dd = '0' + dd;
        return mm + '/' + dd + '/' + d.getFullYear();
    }

    function splitCSVLine(line) {
        return line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
    }

    function isNullOrEmpty(val) {
        return (val === null || val === '' || val === undefined ||
                val === 'undefined' || val === 0 || val === '0');
    }

    return {
        getInputData: getInputData,
        reduce:       reduce,
        summarize:    summarize
    };
});