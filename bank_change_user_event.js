/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/https', 'N/log'], function (https, log) {
    var SUITELET_SCRIPT_ID = 'customscript_hfc_sl_vendor_approval_help';
    var SUITELET_DEPLOYMENT_ID = 'customdeploy_hfc_sl_vendor_approval_help';

    var FIELDS_TO_CHECK = [
        'custrecord_2663_entity_bank_type',
        'custrecord_2663_entity_file_format',
        'custrecord_2663_entity_acct_no',
        'custrecord_2663_entity_acct_name',
        'custrecord_2663_entity_bank_no',
        'custrecord_2663_entity_bank_name',
        'custrecord_2663_entity_branch_no',
        'custrecord_2663_entity_branch_name',
        'custrecord_2663_entity_acct_suffix',
        'custrecord_2663_acct_type',
        'custrecord_2663_parent_vendor',
        'custrecord_2663_parent_employee',
        'custrecord_2663_parent_customer',
        'custrecord_2663_entity_payment_desc',
        'custrecord_2663_edi',
        'custrecord_2663_customer_code',
        'custrecord_2663_edi_value',
        'custrecord_2663_child_id',
        'custrecord_2663_reference',
        'custrecord_2663_baby_bonus',
        'custrecord_2663_entity_iban',
        'custrecord_2663_entity_country_code',
        'custrecord_2663_entity_iban_check',
        'custrecord_2663_entity_country_check',
        'custrecord_2663_entity_bank_code',
        'custrecord_2663_entity_processor_code',
        'custrecord_2663_entity_swift',
        'custrecord_2663_entity_address1',
        'custrecord_2663_entity_address2',
        'custrecord_2663_entity_address3',
        'custrecord_2663_entity_city',
        'custrecord_2663_entity_state',
        'custrecord_2663_entity_zip',
        'custrecord_2663_entity_country',
        'custrecord_2663_entity_bban',
        'custrecord_2663_parent_cust_ref',
        'custrecord_2663_entity_bic',
        'custrecord_2663_entity_bank_acct_type',
        'custrecord_2663_entity_issuer_num',
        'custrecord_2663_parent_partner',
        'custrecord_2663_entity_billing_seq_type',
        'custrecord_2663_date_ref_mandate',
        'custrecord_2663_entity_ref_amended',
        'custrecord_2663_final_pay_date',
        'custrecord_2663_num_payments',
        'custrecord_2663_first_pay_date',
        'custrecord_2663_entity_company_id',
        'custrecord_2663_entity_signature',
        'custrecord_2663_entity_bank_fee_code',
        'custrecord_9572_subsidiary',
        'custrecord_15152_is_acc_num_encrypted',
        'custrecord_ne_approval_status',
        'custrecord_ne_rejection_reason'
    ];

    function afterSubmit(context) {
        log.debug('trigger')
        var newRec = context.newRecord;
        if (context.type == context.UserEventType.EDIT) {

        var oldRec = context.oldRecord;

        var hasChange = false;

        for (var i = 0; i < FIELDS_TO_CHECK.length; i++) {
            var fieldId = FIELDS_TO_CHECK[i];
            log.debug('fieldId', fieldId)
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
    }

        var vendorId = newRec.getValue({ fieldId: 'custrecord_2663_parent_vendor' });
        if (!vendorId) {
            return;
        }

        log.debug('vendorId', vendorId)

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
