/**
 * Custom GL Lines Plug-in - SuiteScript 1.0
 *
 * Existing Standard GL:
 *   Debit  2703    100
 *
 * Custom GL Added:
 *   Credit 2703    100
 *   Debit  2537    100
 */

var SOURCE_ACCOUNT_ID = 2703;    // Account Main / Source Account
var CLEARING_ACCOUNT_ID = 2537;  // AR Clearing

function customizeGlImpact(transactionRecord, standardLines, customLines, book) {
    try {
        var recType = transactionRecord.getRecordType();
        var recId = getRecordId(transactionRecord);

        nlapiLogExecution('DEBUG', 'Custom GL Start', 'Type: ' + recType + ' | ID: ' + recId);

        if (recType !== 'customerpayment') {
            nlapiLogExecution('DEBUG', 'Skipped', 'Not a Customer Payment.');
            return;
        }

        var totalDebitAmount = 0;

        var sourceEntityId = getFieldValue(transactionRecord, 'customer');
        if (isEmpty(sourceEntityId)) {
            sourceEntityId = getFieldValue(transactionRecord, 'entity');
        }

        var sourceDepartmentId = null;
        var sourceClassId = null;
        var sourceLocationId = null;

        /*
         * Step 1:
         * Try from standard GL lines.
         */
        var standardLineCount = standardLines.getCount();

        nlapiLogExecution('DEBUG', 'Standard Line Count', standardLineCount);

        for (var i = 0; i < standardLineCount; i++) {
            var line = standardLines.getLine(i);

            var lineId = getLineValue(line, 'getId');
            var accountId = toNumber(getLineValue(line, 'getAccountId'));
            var debitAmount = toNumber(getLineValue(line, 'getDebitAmount'));
            var creditAmount = toNumber(getLineValue(line, 'getCreditAmount'));
            var isPosting = getPostingValue(line);

            nlapiLogExecution(
                'DEBUG',
                'Standard GL Line',
                'Index: ' + i +
                ' | Line ID: ' + lineId +
                ' | Posting: ' + isPosting +
                ' | Account ID: ' + accountId +
                ' | Debit: ' + debitAmount +
                ' | Credit: ' + creditAmount
            );

            // Skip summary line
            if (Number(lineId) === 0) {
                continue;
            }

            // Skip non-posting line
            if (isPosting === false) {
                continue;
            }

            if (accountId === SOURCE_ACCOUNT_ID && debitAmount > 0) {
                totalDebitAmount += debitAmount;

                sourceEntityId = getLineValue(line, 'getEntityId') || sourceEntityId;
                sourceDepartmentId = getLineValue(line, 'getDepartmentId') || sourceDepartmentId;
                sourceClassId = getLineValue(line, 'getClassId') || sourceClassId;
                sourceLocationId = getLineValue(line, 'getLocationId') || sourceLocationId;
            }
        }

        /*
         * Step 2:
         * If standardLines did not find account 2703,
         * use your transaction search logic as fallback.
         */
        if (totalDebitAmount <= 0 && !isEmpty(recId)) {
            nlapiLogExecution(
                'DEBUG',
                'Fallback Search Started',
                'No standard line found for account ' + SOURCE_ACCOUNT_ID + '. Running transaction search.'
            );

            totalDebitAmount = getDebitAmountFromSearch(recId);
        }

        totalDebitAmount = roundAmount(totalDebitAmount);

        if (totalDebitAmount <= 0) {
            nlapiLogExecution(
                'DEBUG',
                'Skipped',
                'No debit amount found from standard lines or search for account/accountmain ' + SOURCE_ACCOUNT_ID
            );
            return;
        }

        /*
         * Add Custom Credit Line:
         * Credit 2703
         */
        var creditLine = customLines.addNewLine();
        creditLine.setAccountId(SOURCE_ACCOUNT_ID);
        creditLine.setCreditAmount(totalDebitAmount);
        creditLine.setMemo('Offset Customer Payment debit from account ' + SOURCE_ACCOUNT_ID);

        setCommonValues(
            creditLine,
            sourceEntityId,
            sourceDepartmentId,
            sourceClassId,
            sourceLocationId
        );

        /*
         * Add Custom Debit Line:
         * Debit 2537 AR Clearing
         */
        var debitLine = customLines.addNewLine();
        debitLine.setAccountId(CLEARING_ACCOUNT_ID);
        debitLine.setDebitAmount(totalDebitAmount);
        debitLine.setMemo('Move Customer Payment amount to AR Clearing');

        setCommonValues(
            debitLine,
            sourceEntityId,
            sourceDepartmentId,
            sourceClassId,
            sourceLocationId
        );

        nlapiLogExecution(
            'AUDIT',
            'Custom GL Lines Added',
            'Credit Account: ' + SOURCE_ACCOUNT_ID +
            ' | Debit Account: ' + CLEARING_ACCOUNT_ID +
            ' | Amount: ' + totalDebitAmount +
            ' | Entity: ' + sourceEntityId
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
 * Fallback search using your original search logic.
 */
function getDebitAmountFromSearch(paymentId) {
    var totalAmount = 0;

    try {
        var filters = [];

        filters.push(new nlobjSearchFilter('type', null, 'anyof', 'CustPymt'));
        filters.push(new nlobjSearchFilter('debitamount', null, 'isnotempty'));
        filters.push(new nlobjSearchFilter('accountmain', null, 'anyof', String(SOURCE_ACCOUNT_ID)));
        filters.push(new nlobjSearchFilter('internalid', null, 'anyof', String(paymentId)));

        var columns = [];

        columns.push(new nlobjSearchColumn('entityid', 'customer'));
        columns.push(new nlobjSearchColumn('accountmain'));
        columns.push(new nlobjSearchColumn('debitamount'));
        columns.push(new nlobjSearchColumn('subsidiary'));

        var results = nlapiSearchRecord('customerpayment', null, filters, columns);

        if (!results || results.length <= 0) {
            nlapiLogExecution(
                'DEBUG',
                'Fallback Search Result',
                'No search result found for payment ID ' + paymentId
            );
            return 0;
        }

        nlapiLogExecution(
            'DEBUG',
            'Fallback Search Result Count',
            results.length
        );

        for (var i = 0; i < results.length; i++) {
            var debitAmount = results[i].getValue('debitamount');
            var accountMain = results[i].getValue('accountmain');

            var amount = toNumber(debitAmount);

            nlapiLogExecution(
                'DEBUG',
                'Fallback Search Line',
                'Account Main: ' + accountMain + ' | Debit Amount: ' + amount
            );

            if (amount > 0) {
                totalAmount += amount;
            }
        }

    } catch (e) {
        nlapiLogExecution(
            'ERROR',
            'Fallback Search Error',
            'Name: ' + e.name + ' | Message: ' + e.message
        );
    }

    return totalAmount;
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
 * Get transaction field value.
 */
function getFieldValue(transactionRecord, fieldId) {
    try {
        if (transactionRecord && typeof transactionRecord.getFieldValue === 'function') {
            return transactionRecord.getFieldValue(fieldId);
        }
    } catch (e) {
        // ignore
    }

    return null;
}

/**
 * Safely get value from standard GL line.
 */
function getLineValue(line, methodName) {
    try {
        if (line && typeof line[methodName] === 'function') {
            var value = line[methodName]();
            return isEmpty(value) ? null : value;
        }
    } catch (e) {
        // ignore
    }

    return null;
}

/**
 * Safely get posting value.
 */
function getPostingValue(line) {
    try {
        if (line && typeof line.isPosting === 'function') {
            return line.isPosting();
        }
    } catch (e) {
        // ignore
    }

    return true;
}

/**
 * Set entity/department/class/location on custom GL lines if available.
 */
function setCommonValues(customLine, entityId, departmentId, classId, locationId) {
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