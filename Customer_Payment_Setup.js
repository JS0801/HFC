/**
 * Custom GL Lines Plug-in - SuiteScript 1.0
 *
 * Uses a transaction summary search to find Customer Payment debit lines
 * where the posting account is configured for AR clearing:
 *   account.custrecord_hfc_ar_clearing_flow    = T
 *   account.custrecord_hfc_ar_clearing_account is not empty
 *
 * Existing Standard GL:
 *   Debit  account flagged for AR clearing flow    100
 *
 * Custom GL Added:
 *   Credit flagged source account                  100
 *   Debit  configured AR clearing account          100
 */

var CLEARING_FLOW_FIELD_ID = 'custrecord_hfc_ar_clearing_flow';
var CLEARING_ACCOUNT_FIELD_ID = 'custrecord_hfc_ar_clearing_account';

function customizeGlImpact(transactionRecord, standardLines, customLines, book) {
    try {
        var recType = transactionRecord.getRecordType();
        var recId = getRecordId(transactionRecord);

        nlapiLogExecution('DEBUG', 'Custom GL Start', 'Type: ' + recType + ' | ID: ' + recId);

        if (recType !== 'customerpayment') {
            nlapiLogExecution('DEBUG', 'Skipped', 'Not a Customer Payment.');
            return;
        }

        if (isEmpty(recId)) {
            nlapiLogExecution('DEBUG', 'Skipped', 'Customer Payment ID is empty.');
            return;
        }

        var adjustments = getDebitAdjustmentsFromSearch(recId);

        if (adjustments.length <= 0) {
            nlapiLogExecution(
                'DEBUG',
                'Skipped',
                'No debit amount found for any account flagged with ' + CLEARING_FLOW_FIELD_ID
            );
            return;
        }

        var totalAdjustedAmount = 0;
        var addedAdjustmentCount = 0;

        for (var j = 0; j < adjustments.length; j++) {
            var adjustment = adjustments[j];
            var adjustmentAmount = roundAmount(adjustment.amount);

            if (adjustmentAmount <= 0) {
                continue;
            }

            /*
             * Add Custom Credit Line:
             * Credit source account from the standard GL line.
             */
            var creditLine = customLines.addNewLine();
            creditLine.setAccountId(Number(adjustment.sourceAccountId));
            creditLine.setCreditAmount(adjustmentAmount);
            creditLine.setMemo('Offset Customer Payment debit from account ' + adjustment.sourceAccountId);

            setCommonValues(
                creditLine,
                adjustment.entityId,
                adjustment.departmentId,
                adjustment.classId,
                adjustment.locationId,
                adjustment.projectId
            );

            /*
             * Add Custom Debit Line:
             * Debit configured AR clearing account.
             */
            var debitLine = customLines.addNewLine();
            debitLine.setAccountId(Number(adjustment.clearingAccountId));
            debitLine.setDebitAmount(adjustmentAmount);
            debitLine.setMemo('Move Customer Payment amount to AR Clearing');

            setCommonValues(
                debitLine,
                adjustment.entityId,
                adjustment.departmentId,
                adjustment.classId,
                adjustment.locationId,
                adjustment.projectId
            );

            totalAdjustedAmount += adjustmentAmount;
            addedAdjustmentCount++;
        }

        if (addedAdjustmentCount <= 0) {
            nlapiLogExecution(
                'DEBUG',
                'Skipped',
                'Clearing flow accounts were found, but all adjustment amounts rounded to zero.'
            );
            return;
        }

        nlapiLogExecution(
            'AUDIT',
            'Custom GL Lines Added',
            'Adjustment Count: ' + addedAdjustmentCount +
            ' | Total Amount: ' + roundAmount(totalAdjustedAmount)
        );

    } catch (e) {
        nlapiLogExecution(
            'ERROR',
            'Custom GL Error',
            'Name: ' + e.name + ' | Message: ' + e.message
        );
    }
}

/**
 * Summary search based on the provided Customer Payment search.
 */
function getDebitAdjustmentsFromSearch(paymentId) {
    var adjustments = [];

    try {
        var filters = [];

        filters.push(new nlobjSearchFilter('type', null, 'anyof', 'CustPymt'));
        filters.push(new nlobjSearchFilter(CLEARING_FLOW_FIELD_ID, 'account', 'is', 'T'));
        filters.push(new nlobjSearchFilter(CLEARING_ACCOUNT_FIELD_ID, 'account', 'noneof', '@NONE@'));
        filters.push(new nlobjSearchFilter('internalid', null, 'anyof', String(paymentId)));

        var columns = [];

        columns.push(new nlobjSearchColumn('internalid', null, 'GROUP'));
        columns.push(new nlobjSearchColumn('debitamount', null, 'SUM'));
        columns.push(new nlobjSearchColumn('internalid', 'account', 'MAX'));
        columns.push(new nlobjSearchColumn(CLEARING_ACCOUNT_FIELD_ID, 'account', 'GROUP'));
        columns.push(new nlobjSearchColumn('memo', null, 'GROUP'));
        columns.push(new nlobjSearchColumn('location', null, 'GROUP'));
        columns.push(new nlobjSearchColumn('department', null, 'GROUP'));
        columns.push(new nlobjSearchColumn('class', null, 'GROUP'));
        columns.push(new nlobjSearchColumn('cseg1', null, 'GROUP'));
        columns.push(new nlobjSearchColumn('entity', null, 'GROUP'));

        var results = nlapiSearchRecord('customerpayment', null, filters, columns);

        if (!results || results.length <= 0) {
            nlapiLogExecution(
                'DEBUG',
                'Clearing Flow Search Result',
                'No search result found for payment ID ' + paymentId
            );
            return adjustments;
        }

        nlapiLogExecution(
            'DEBUG',
            'Clearing Flow Search Result Count',
            results.length
        );

        for (var i = 0; i < results.length; i++) {

          nlapiLogExecution('DEBUG', 'results[' + i + ']', JSON.stringify(results[i]));
            var amount = roundAmount(getSummaryValue(results[i], columns[1], 'debitamount', null, 'SUM'));
            var accountId = toNumber(getSummaryValue(results[i], columns[2], 'internalid', 'account', 'MAX'));
            var clearingAccountId = toNumber(getSummaryValue(results[i], columns[3], CLEARING_ACCOUNT_FIELD_ID, 'account', 'GROUP'));

            if (amount <= 0 || accountId <= 0 || clearingAccountId <= 0) {
                nlapiLogExecution(
                    'DEBUG',
                    'Clearing Flow Search Line Skipped',
                    'Amount: ' + amount +
                    ' | Account: ' + accountId +
                    ' | Clearing Account: ' + clearingAccountId
                );
                continue;
            }

            nlapiLogExecution(
                'DEBUG',
                'Clearing Flow Search Line',
                'Account Main: ' + accountId +
                ' | Debit Amount: ' + amount +
                ' | Clearing Account: ' + clearingAccountId
            );

            adjustments.push({
                sourceAccountId: accountId,
                clearingAccountId: clearingAccountId,
                amount: amount,
                memo: getSummaryValue(results[i], columns[4], 'memo', null, 'GROUP'),
                locationId: getSummaryValue(results[i], columns[5], 'location', null, 'GROUP'),
                departmentId: getSummaryValue(results[i], columns[6], 'department', null, 'GROUP') || 1,
                classId: getSummaryValue(results[i], columns[7], 'class', null, 'GROUP'),
                projectId: getSummaryValue(results[i], columns[8], 'cseg1', null, 'GROUP'),
                entityId: getSummaryValue(results[i], columns[9], 'entity', null, 'GROUP')
            });
        }

    } catch (e) {
        nlapiLogExecution(
            'ERROR',
            'Clearing Flow Search Error',
            'Name: ' + e.name + ' | Message: ' + e.message
        );
    }

    return adjustments;
}

/**
 * Read a summary search value in a way that works across NetSuite 1.0 variants.
 */
function getSummaryValue(result, column, name, join, summary) {
    var value = null;

    try {
        value = result.getValue(column);
    } catch (e1) {
        value = null;
    }

    if (!isEmpty(value)) {
        return value;
    }

    try {
        return result.getValue(name, join, summary);
    } catch (e2) {
        return null;
    }
}

/**
 * Get transaction internal ID.
 */
function getRecordId(transactionRecord) {
    try {
        if (transactionRecord && typeof transactionRecord.getId === 'function') {
            return transactionRecord.getId();
        }
    } catch (e1) {
        // ignore
    }

    try {
        return transactionRecord.getFieldValue('id');
    } catch (e2) {
        // ignore
    }

    return null;
}

/**
 * Set entity/department/class/location/project on custom GL lines if available.
 */
function setCommonValues(customLine, entityId, departmentId, classId, locationId, projectId) {
    try {
        if (!isEmpty(entityId)) {
            customLine.setEntityId(Number(entityId));
        }
    } catch (e1) {
        nlapiLogExecution('DEBUG', 'Entity Not Set', e1.message);
    }

    try {
        if (!isEmpty(departmentId)) {
          customLine.setDepartmentId(Number(departmentId));
        }
    } catch (e2) {
        nlapiLogExecution('DEBUG', 'Department Not Set', e2.message);
    }

    try {
        if (!isEmpty(classId)) {
            customLine.setClassId(Number(classId));
        }
    } catch (e3) {
        nlapiLogExecution('DEBUG', 'Class Not Set', e3.message);
    }

    try {
        if (!isEmpty(locationId)) {
            customLine.setLocationId(Number(locationId));
        }
    } catch (e4) {
        nlapiLogExecution('DEBUG', 'Location Not Set', e4.message);
    }

    try {
        if (!isEmpty(projectId) && typeof customLine.setSegmentValueId === 'function') {
            customLine.setSegmentValueId('cseg1', Number(projectId));
        }
    } catch (e5) {
        nlapiLogExecution('DEBUG', 'Project Not Set', e5.message);
    }
}

/**
 * Convert value to number.
 */
function toNumber(value) {
    var num = parseFloat(String(value || '').replace(/,/g, ''));

    if (isNaN(num)) {
        return 0;
    }

    return num;
}

/**
 * Round amount to 2 decimals.
 */
function roundAmount(value) {
    return Number((Math.round(toNumber(value) * 100) / 100).toFixed(2));
}

/**
 * Empty check.
 */
function isEmpty(value) {
    return value === null ||
        value === undefined ||
        value === '' ||
        String(value).trim() === '';
}
