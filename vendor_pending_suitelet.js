/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/record'], function (record) {
    function onRequest(context) {
        var vendorId = context.request.parameters.vendorid;

        if (!vendorId) {
            context.response.write('Missing vendorid');
            return;
        }

        record.submitFields({
            type: record.Type.VENDOR,
            id: vendorId,
            values: {
                custentity_img_approval_status: 1
            },
            options: {
                enableSourcing: false,
                ignoreMandatoryFields: true
            }
        });

        context.response.write('Vendor set to pending approval');
    }

    return {
        onRequest: onRequest
    };
});
