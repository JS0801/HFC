/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/https'], function (https) {
    var SUITELET_SCRIPT_ID = 'customscript_hfc_sl_vendor_approval_help';
    var SUITELET_DEPLOYMENT_ID = 'customdeploy_your_suitelet_deploy_id';

    var FIELDS_TO_CHECK = [
        'name',
        'custrecord_2663_entity_file_format',
        'custrecord_2663_entity_bank_type',
        'custrecord_2663_entity_acct_no',
        'custrecord_2663_entity_bank_no',
        'custrecord_2663_entity_branch_no',
        'custrecord_9572_subsidiary'
    ];

    function afterSubmit(context) {
        if (context.type !== context.UserEventType.EDIT) {
            return;
        }

        var oldRec = context.oldRecord;
        var newRec = context.newRecord;
        var hasChange = false;

        for (var i = 0; i < FIELDS_TO_CHECK.length; i++) {
            var fieldId = FIELDS_TO_CHECK[i];
            var oldValue = oldRec.getValue({ fieldId: fieldId });
            var newValue = newRec.getValue({ fieldId: fieldId });

            if (String(oldValue || '') !== String(newValue || '')) {
                hasChange = true;
                break;
            }
        }

        if (!hasChange) {
            return;
        }

        var vendorId = newRec.getValue({ fieldId: 'custrecord_2663_parent_vendor' });
        if (!vendorId) {
            return;
        }

        https.requestSuitelet({
            scriptId: SUITELET_SCRIPT_ID,
            deploymentId: SUITELET_DEPLOYMENT_ID,
            method: https.Method.GET,
            urlParams: {
                vendorid: vendorId
            }
        });
    }

    return {
        afterSubmit: afterSubmit
    };
});
