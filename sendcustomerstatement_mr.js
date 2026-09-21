/**	
 * @NApiVersion 2.x
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 */
define(['N/record','N/search','N/runtime','N/format', 'N/email','N/render','N/xml','SuiteScripts/buildXML.js','N/file', 'N/task'],

function(record,search,runtime,format,email,render,xml,mylibrary, file, task) {
	
  function getInputData() {
    try {
        var results_array = [];

        var searchId = runtime.getCurrentScript().getParameter("custscript_customerstosend");
        log.audit('[AUDIT][getInputData] searchId param', searchId);

        if (!isNullOrEmpty(searchId)) {
            var customerSearchObj = search.load({
                id: searchId
            });

            var pagedData = customerSearchObj.runPaged({
                pageSize: 1000
            });

            log.audit('[AUDIT][getInputData] total search result count', pagedData.count);

            var uniqueCustomers = {};
            var duplicateCount = 0;

            for (var p = 0; p < pagedData.pageRanges.length; p++) {
                var page = pagedData.fetch({
                    index: pagedData.pageRanges[p].index
                });

                for (var r = 0; r < page.data.length; r++) {
                    var result = page.data[r];

                    var cust_internalid = result.getValue({
                        name: 'internalid'
                    });

                    var sub_internalid = result.getValue({
                        name: 'internalid',
                        join: 'mseSubsidiary'
                    });

                    if (isNullOrEmpty(cust_internalid)) {
                        continue;
                    }

                    if (uniqueCustomers[cust_internalid]) {
                        duplicateCount++;
                        continue;
                    }

                    uniqueCustomers[cust_internalid] = true;

                    results_array.push({
                        cust_internalid: cust_internalid,
                        sub: sub_internalid,
                        type: 'automatic'
                    });
                }
            }

            log.audit('[AUDIT][getInputData] duplicate customer rows skipped', duplicateCount);

            // Save the JSON array we are actually returning to Map/Reduce
            var debugFile = file.create({
                name: 'customer_statement_unique_customers_' + new Date().getTime() + '.txt',
                fileType: file.Type.PLAINTEXT,
                contents: JSON.stringify(results_array),
                folder: 499157
            });

            var debugFileId = debugFile.save();

            log.audit('[AUDIT][getInputData] debug JSON file saved', {
                fileId: debugFileId,
                count: results_array.length
            });

            // Create CSV placeholder file for saved search export
            var exportFile = file.create({
                name: 'customer_statement_saved_search_export_' + new Date().getTime() + '.csv',
                fileType: file.Type.CSV,
                contents: '',
                folder: 499157
            });

            var exportFileId = exportFile.save();

            // Submit async saved search export task
            var searchTask = task.create({
                taskType: task.TaskType.SEARCH
            });

            searchTask.savedSearchId = searchId;
            searchTask.fileId = exportFileId;

            var searchTaskId = searchTask.submit();

            log.audit('[AUDIT][getInputData] saved search export task submitted', {
                taskId: searchTaskId,
                exportFileId: exportFileId,
                searchId: searchId
            });

        } else {
            var customerList = runtime.getCurrentScript().getParameter("custscript_customerlist");
            log.audit('[AUDIT][getInputData] using manual customerlist param', customerList);

            if (!isNullOrEmpty(customerList)) {
                results_array = JSON.parse(customerList);
            }
        }

        log.audit('[AUDIT][getInputData] results_array length', results_array.length);
        return results_array;

    } catch (e) {
        log.audit({
            title: '[AUDIT][getInputData] ERROR: ' + e.name,
            details: e.message + ' | stack=' + (e.stack || 'n/a')
        });

        return [];
    }
}

    function map(context) {
   
		try{

		}catch(e){
			
			log.audit({
				title: e.name,
				details: e.message
			});	
			
		}
    }

function map(context) {
    var TAG = '[AUDIT][map]';

    try {
        log.audit(TAG + ' ENTER', {
            key: context.key,
            value: context.value
        });

        var resultObj = JSON.parse(context.value);
        var customer_id = resultObj.cust_internalid;
        var sub_id = resultObj.sub_internalid
        var type = resultObj.type;

        TAG = '[AUDIT][map][cust:' + customer_id + ']';

        log.audit(TAG + ' parsed input', {
            customer_id: customer_id,
            sub_id: sub_id,
            type: type
        });

        var pdf_array = [];

        log.audit(TAG + ' loading customer record', customer_id);

        var cusObj = record.load({
            type: record.Type.CUSTOMER,
            id: customer_id
        });

        var companyname = cusObj.getValue({ fieldId: 'companyname' });
        var altName = cusObj.getValue({ fieldId: 'glommedname' });
        var custEmail = cusObj.getValue({ fieldId: 'email' });
        var custInactive = cusObj.getValue({ fieldId: 'isinactive' });
        var custOnCreditHold = cusObj.getValue({ fieldId: 'creditholdoverride' });

        log.audit(TAG + ' customer loaded', {
            companyname: companyname,
            altName: altName,
            email: custEmail,
            isinactive: custInactive,
            creditholdoverride: custOnCreditHold
        });

        if (isNullOrEmpty(custEmail)) {
            log.audit(TAG + ' WARNING - customer has no email', {
                customer_id: customer_id,
                companyname: companyname
            });
        }

        if (custInactive === true || custInactive === 'T') {
            log.audit(TAG + ' WARNING - customer is inactive', {
                customer_id: customer_id,
                companyname: companyname
            });
        }

        if(!sub_id) {
         sub_id = cusObj.getValue({ fieldId: 'subsidiary' });

        log.audit(TAG + ' customer subsidiary', sub_id);

        if (isNullOrEmpty(sub_id)) {
            log.audit(TAG + ' SKIP - customer has no subsidiary', {
                customer_id: customer_id,
                companyname: companyname
            });
            return;
        }

        log.audit(TAG + ' loading subsidiary record', sub_id);
        }



        var subObj = record.load({
            type: record.Type.SUBSIDIARY,
            id: sub_id,
            isDynamic: true
        });

        var subEmail = subObj.getValue({ fieldId: 'custrecord_ne_statement_email' });
        var subTemplate = subObj.getValue({ fieldId: 'custrecord_ne_statement_template' });

        log.audit(TAG + ' subsidiary loaded', {
            sub_id: sub_id,
            statementEmail: subEmail,
            statementTemplate: subTemplate
        });

        if (isNullOrEmpty(subEmail)) {
            log.audit(TAG + ' WARNING - subsidiary statement email is empty', {
                sub_id: sub_id
            });
        }

        var email_body;
        var searchId = runtime.getCurrentScript().getParameter("custscript_customerstosend");
        var dateToday = formatDate();

        if (type == 'manual') {
            var tempBody;
            var testSearch;
            var Subsidiary;

            log.audit(TAG + ' looking up manual template', {
                sub_id: sub_id
            });

            var customrecord_ne_custom_templateSearchObj = search.create({
                type: "customrecord_ne_custom_template",
                filters: [
                    ["custrecord_ne_template_type", "is", "F"],
                    "AND",
                    ["custrecord_ne_template_subsidiary", "anyof", sub_id]
                ],
                columns: [
                    search.createColumn({ name: "internalid", label: "Internal ID" }),
                    search.createColumn({ name: "custrecord_ne_template_subsidiary", label: "Subsidiary" }),
                    search.createColumn({ name: "custrecord_ne_template_text", label: "Template Text" }),
                    search.createColumn({ name: "custrecord_ne_template_search", label: "Saved search" })
                ]
            });

            var searchResultCount = customrecord_ne_custom_templateSearchObj.runPaged().count;

            log.audit(TAG + ' manual template search result count', searchResultCount);

            customrecord_ne_custom_templateSearchObj.run().each(function(result) {
                tempBody = result.getValue({ name: 'custrecord_ne_template_text' });
                return true;
            });

            log.audit(TAG + ' manual template resolved', {
                hasBody: !isNullOrEmpty(tempBody),
                bodyLength: tempBody ? tempBody.length : 0
            });

            if (isNullOrEmpty(tempBody)) {
                log.audit(TAG + ' WARNING - no manual template body found', {
                    sub_id: sub_id
                });
            }

            email_body = "Attached is the most recent statement of your account as of " + dateToday + ".<br/><br/>" + tempBody;

        } else {
            var checkName;
            var tempBody;

            log.audit(TAG + ' looking up automatic template', {
                sub_id: sub_id,
                searchId: searchId
            });

            var customrecord_ne_custom_templateSearchObj = search.create({
                type: "customrecord_ne_custom_template",
                filters: [
                    ["custrecord_ne_template_type", "is", "T"],
                    "AND",
                    ["custrecord_ne_template_subsidiary", "anyof", sub_id],
                    "AND",
                    ["custrecord_ne_template_search", "anyof", searchId]
                ],
                columns: [
                    search.createColumn({ name: "custrecord_ne_template_text", label: "Template Text" }),
                    search.createColumn({ name: "custrecord_ne_template_name", label: "Name" }),
                    search.createColumn({ name: "custrecord_ne_template_search", label: "Saved search" })
                ]
            });

            var searchResultCount = customrecord_ne_custom_templateSearchObj.runPaged().count;

            log.audit(TAG + ' automatic template search result count', {
                count: searchResultCount,
                sub_id: sub_id,
                searchId: searchId
            });

            customrecord_ne_custom_templateSearchObj.run().each(function(result) {
                tempBody = result.getValue({ name: 'custrecord_ne_template_text' });
                checkName = result.getValue({ name: 'custrecord_ne_template_name' });
                return true;
            });

            log.audit(TAG + ' automatic template resolved', {
                templateName: checkName,
                hasBody: !isNullOrEmpty(tempBody),
                bodyLength: tempBody ? tempBody.length : 0
            });

            if (isNullOrEmpty(tempBody)) {
                log.audit(TAG + ' WARNING - no automatic template body found', {
                    sub_id: sub_id,
                    searchId: searchId
                });
            }

            if (checkName == 'company') {
                email_body = "Attached is the most recent statement of your account as of " + dateToday + ".<br/><br/>" + tempBody;
            } else {
                email_body = "Attached is the most recent statement of your account as of " + dateToday + ". <br/>" + tempBody;
            }
        }

        var empSender;

        log.audit(TAG + ' looking up sender employee', {
            subEmail: subEmail
        });

        var employeeSearchObj = search.create({
            type: "employee",
            filters: [
                ["email", "is", subEmail],
                "AND",
                ["isinactive", "is", "F"]
            ],
            columns: [
                search.createColumn({ name: "internalid", label: "Internal ID" }),
                search.createColumn({ name: "email", label: "Email" })
            ]
        });

        var searchResultCount = employeeSearchObj.runPaged().count;

        employeeSearchObj.run().each(function(result) {
            empSender = result.getValue({ name: 'internalid' });
            return true;
        });

        log.audit(TAG + ' sender employee lookup result', {
            subEmail: subEmail,
            resultCount: searchResultCount,
            empSender: empSender
        });

        if (searchResultCount > 0) {
            log.audit(TAG + ' building XML via mylibrary.buildXML', customer_id);

            var xml_body = mylibrary.buildXML(customer_id);

            log.audit(TAG + ' XML build result', {
                hasXml: !isNullOrEmpty(xml_body),
                xmlLength: xml_body ? xml_body.length : 0
            });

            if (isNullOrEmpty(xml_body)) {
                log.audit(TAG + ' SKIP - buildXML returned empty', {
                    customer_id: customer_id,
                    companyname: companyname
                });
                return;
            }

            log.audit(TAG + ' rendering PDF from XML');

            var pdf_file = render.xmlToPdf({
                xmlString: xml_body
            });

            pdf_file.name = 'Statement.pdf';
            pdf_array.push(pdf_file);

            log.audit(TAG + ' PDF generated', {
                attachmentCount: pdf_array.length
            });

            log.audit(TAG + ' sending email', {
                author: empSender,
                recipient: parseInt(customer_id),
                customerEmail: custEmail,
                subject: 'Customer Statement',
                attachmentCount: pdf_array.length,
                bodyLength: email_body ? email_body.length : 0
            });

            try {
                email.send({
                    author: empSender,
                    recipients: parseInt(customer_id),
                    subject: 'Customer Statement',
                    body: email_body,
                    attachments: pdf_array
                });

                log.audit(TAG + ' SUCCESS - email sent', {
                    customer_id: customer_id,
                    companyname: companyname,
                    customerEmail: custEmail
                });

            } catch (sendErr) {
                log.audit(TAG + ' FAILED - email.send error: ' + sendErr.name, {
                    message: sendErr.message,
                    customer_id: customer_id,
                    companyname: companyname
                });
            }

        } else {
            log.audit(TAG + ' SKIP - no active employee sender found', {
                subEmail: subEmail,
                customer_id: customer_id,
                companyname: companyname
            });
        }

    } catch (e) {
        log.audit({
            title: TAG + ' UNCAUGHT ERROR: ' + e.name,
            details: e.message + ' | stack=' + (e.stack || 'n/a')
        });
    }
}

    function summarize(summary) {
		
    	summary.usage;
    	
		log.audit({
			title: 'Usage',
			details: summary.usage
		});
		log.audit({
			title: 'Concurrency',
			details: summary.concurrency
		});
		log.audit({
			title: 'Yields',
			details: summary.yields
		});

		// Collect any reduce-stage errors that escaped the try/catch
		var reduceErrors = 0;
		summary.reduceSummary.errors.iterator().each(function(key, error) {
			reduceErrors++;
			log.audit('[AUDIT][summarize] reduce error for key '+key, error);
			return true;
		});
		log.audit('[AUDIT][summarize] total reduce errors', reduceErrors);

		// Also surface input-stage errors
		summary.inputSummary && summary.inputSummary.error && log.audit('[AUDIT][summarize] inputSummary error', summary.inputSummary.error);
    }

	function formatDate() {
	
		var current_date = new Date();
		var trandate = current_date.getDate();
		var tranmonth = current_date.getMonth() + 1;
		var tranyear = current_date.getFullYear();
	
		if (trandate < 10) {
		trandate = '0' + trandate;
		}
	
		if (tranmonth < 10) {
		tranmonth = '0' + tranmonth;
		}
	
		var fullDate = tranmonth +'/'+ trandate +'/'+ tranyear;

		return fullDate;
	}

	
	function isNullOrEmpty(objVariable) {
		return (objVariable == null || objVariable == "" || objVariable == undefined || objVariable == 'undefined' || objVariable == 0);
	}; 
	 


    return {
        getInputData: getInputData,
        map: map,
		//reduce: reduce,
        summarize: summarize
    };
    
});