/**
 * @NApiVersion 2.x
 * @NScriptType MapReduceScript
 */
define(['N/file', 'N/search', 'N/runtime', 'N/record', 'N/email', 'N/error','N/task', 'N/encode', 'N/format'], 

	function (file, search, runtime, record, email, error, task, encode,format) {
    function getInputData() {
        //Replace Folder Location

        var file_id;

        if(!isNullOrEmpty(file_id))
        {
            file_id = runtime.getCurrentScript().getParameter("custscript_fileid");
        }
        else{
            //Change folder prod - 329224  SB - 

            var fileSearchObj = search.create({
                type: "file",
                filters:
                [
                ["folder","anyof","329224"]
                ],
                columns:
                [
                search.createColumn({name: "internalid", label: "Internal ID"}),
                ]
            });
            var searchResultCount = fileSearchObj.runPaged().count;
            log.debug("fileSearchObj result count",searchResultCount);
            fileSearchObj.run().each(function(result){
                file_id =  result.getValue({ name: 'internalid'});
                return true;
            });

        }
            
        var paymentfiles = [];
        if(searchResultCount > 0)
        {
            log.debug("file_id",file_id);
            var csvFile = file.load({ id: file_id});
            var fileName = csvFile.name;
            var fileSearchObj = search.create({
                type: "file",
                filters:
                [
                    ["name","is",fileName], 
                    "AND", 
                    ["folder","anyof","329225"]
                ],
                columns:
                [
                search.createColumn({name: "internalid", label: "Internal ID"}),
                ]
            });
            var searchResultCount = fileSearchObj.runPaged().count;
            log.debug("fileSearchObj result count",searchResultCount);
            if(searchResultCount > 0)
            {
                paymentfiles  = [];
                //Duplicate folder PROD -398330 SB - 341419- 
                csvFile.description = 'Duplicate';
                csvFile.folder = 398330;
                csvFile.save();
                log.debug("DUPLICATE FILE MOVED");
            }else{
                var arrLines = csvFile.getContents().split(/\n|\n\r/);
                
                for (var y = 1; y < arrLines.length;y++)
                {
                    if(isNullOrEmpty(arrLines[y]))
                    {
                        arrLines.splice(y, 1)
                    }
                }
            
                log.debug("arrLines",arrLines);
                //arrLines.length
                for (var i = 1; i < arrLines.length; i++) 
                {
                    
                    var payment_Column;
                    var content = arrLines[i].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
                    
                    var checkCanadian = content[24];
                    var checkPaymentColumn = content[12];
                    var checkPymt = content[11];
                    var checkNextAmount = content[12];
                    var checkCurreny = content[8];
                    var checkReturn = content[7];

                    log.debug('checkCurreny',checkCurreny);
                    log.debug('checkCanadian',checkCanadian);
                    log.debug('checkPaymentColumn',checkPaymentColumn);
                    if(checkCanadian == "2" && checkPaymentColumn == "")
                    {
                        var checkReturnPreviousContent = arrLines[i - 1].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
                        log.debug('checkReturnPreviousContent',checkReturnPreviousContent);
                        var checkReturnPrevious = checkReturnPreviousContent[7];
                        //log.debug('checkReturnPrevious',checkReturnPrevious);
                        if(checkReturnPrevious == 'Return')
                        {
                            log.debug('Create Return',checkReturnPrevious);
                            var removeWordString = content[25];
                            
                            payment_Column = removeWordString.substr(removeWordString.indexOf(':') + 2);
                            
                            var paymentObj = {
                                'payment_Column': payment_Column,
                                'file_id': file_id,
                                'currency': 'CAD'
                            }                    
                            paymentfiles.push(paymentObj)
                        }

                    } 
                    if(checkCanadian == "2" && checkPaymentColumn != "" && checkCurreny == "CAD" && checkReturn == 'Return')
                    {
                            log.debug('Create Return');
                            payment_Column = content[11]
                            var paymentObj = {
                                'payment_Column': payment_Column,
                                'file_id': file_id,
                                'currency': 'CAD'
                            }                    
                            paymentfiles.push(paymentObj)
                        

                    } 


                    
                    if(checkCurreny != "CAD" && checkCanadian != "2" && checkPaymentColumn != "" && checkReturn == 'Return')
                    {

                        log.debug('NOT CANADIAN');
                        if(checkPymt.substring(0,4) == "PYMT" && checkNextAmount.substring(0,4) != "PYMT")
                        {
                            log.debug('checkPymtINSIDE',checkPymt);
                            payment_Column = content[11];
                            
                            var paymentObj = {
                                'payment_Column': payment_Column,
                                'file_id': file_id,
                                'currency': 'USD'
                            }
                            paymentfiles.push(paymentObj)
                        }else if(checkNextAmount.substring(0,4) == "PYMT" &&  checkPymt.substring(0,4) != "PYMT")
                        {
                            payment_Column = content[12];
                            
                            var paymentObj = {
                                'payment_Column': payment_Column,
                                'file_id': file_id,
                                'currency': 'USD'
                            }
                            paymentfiles.push(paymentObj)
                        }else if(checkPymt.substring(0,4) != "PYMT" && checkNextAmount.substring(0,4) != "PYMT" && checkCurreny != "CAD")
                        {
                            log.debug('APSIDE');
                            payment_Column = content[11];
                            
                            var paymentObj = {
                                'payment_Column': payment_Column,
                                'file_id': file_id,
                                'currency': 'USD'
                            }
                            paymentfiles.push(paymentObj)
                        }

                        
                    
                    }
                }
            }
            

        }
        log.debug('paymentfiles',paymentfiles);

        return paymentfiles; 
    }



    function reduce(context) 
    {
        try
        {
            var search_result	= context.values;
            var newObj = JSON.parse(search_result[0]);
            var paymentNo = newObj.payment_Column;
            var fileid = newObj.file_id;
            var currency_name = newObj.currency;
            log.debug("currency_name",currency_name);
            var payment_id;
            var account;
            var vendorPaymentCreditAccount;
            var vendorPaymentDebitAccount;
            var transactionType;

            if(paymentNo.substring(0,4) != "PYMT")
            {
                var transactionSearchObj = search.create({
                type: "transaction",
                settings:[{"name":"consolidationtype","value":"ACCTTYPE"}],
                filters:
                [
                    ["numbertext","is",paymentNo]
                ],
                columns:
                [
                    search.createColumn({name: "internalid", label: "Internal ID"}),
                    search.createColumn({name: "account", label: "Account"}),
                    search.createColumn({name: "creditfxamount", label: "Amount (Credit) (Foreign Currency)"}),
                    search.createColumn({name: "debitfxamount", label: "Amount (Debit) (Foreign Currency)"}),
                    search.createColumn({name: "recordtype", label: "Record Type"}),
                    search.createColumn({name: "accountmain", label: "Account (Main)"})

                ]
                });
                var searchResultCount = transactionSearchObj.runPaged().count;
                log.debug("transactionSearchObj result count",searchResultCount);
                transactionSearchObj.run().each(function(result){
                    payment_id =  result.getValue({ name: 'internalid'});
                    var checkDebit = result.getValue({ name: 'debitfxamount'})
                    var checkCredit = result.getValue({ name: 'creditfxamount'})
                    transactionType = result.getValue({ name: 'recordtype'});
                    account = result.getValue({ name: 'accountmain'});
                    //log.debug("TRANTYPE",transactionType);                    
                    if(isNullOrEmpty(checkDebit))
                    {
                        vendorPaymentDebitAccount = result.getValue({ name: 'account'});
                    }
                    if(isNullOrEmpty(checkCredit))
                    {
                        vendorPaymentCreditAccount = result.getValue({ name: 'account'});
                    }

                return true;
                });            
            }else{
                var transactionSearchObj = search.create({
                type: "transaction",
                filters:
                    [
                    ["numbertext","is",paymentNo], 
                    "AND", 
                    ["mainline","is","T"]
                    ],
                    columns:
                    [
                    search.createColumn({name: "internalid", label: "Internal ID"}),
                    search.createColumn({name: "accountmain", label: "Account (Main)"})
                    
                    ]
                });
                var searchResultCount = transactionSearchObj.runPaged().count;
                //log.debug("transactionSearchObj result count",searchResultCount);
                transactionSearchObj.run().each(function(result){
                    payment_id =  result.getValue({ name: 'internalid'});
                    account =  result.getValue({ name: 'accountmain'});

                    return true;
                });

            }




            //log.debug("payment_id",payment_id);
             log.debug("paymentNo",paymentNo);
             log.debug("account",account);
            

            if(!isNullOrEmpty(payment_id) && transactionType != 'customerrefund')
            {
                if(paymentNo.substring(0,4) != "PYMT")
                {
                    var paymentObj = record.load({
                        type: record.Type.VENDOR_PAYMENT,
                        id: parseInt(payment_id)
                    });
                    var entityId   = paymentObj.getValue({fieldId: 'entity'}); 
                    var debitAccount   = vendorPaymentDebitAccount;
                    var creditAccount = vendorPaymentCreditAccount;
                    var payment_amount   = paymentObj.getValue({fieldId: 'total'});
                    var entitySub       = paymentObj.getValue({fieldId: 'subsidiary'});
                    // var vendorObj = search.lookupFields({
					// 		type: search.Type.VENDOR,
					// 		id: parseInt(entityId),
					// 		columns: ['subsidiary']
				    // });
                    // var entitySub = vendorObj.subsidiary[0].value 
                    log.debug('vendorSub', entitySub)
                    log.debug('VENDORpayment_amount', payment_amount)
                    log.debug('creditAccount', creditAccount)
                    log.debug('creditAcdebitAccountcount', debitAccount)
                }else
                {
                    var paymentObj = record.load({
                        type: record.Type.CUSTOMER_PAYMENT,
                        id: parseInt(payment_id)
                    });
                    var payment_amount   = paymentObj.getValue({fieldId: 'payment'}); 
                        
                    var entityId   = paymentObj.getValue({fieldId: 'customer'});
                    var debitAccount   = paymentObj.getValue({fieldId: 'aracct'});
                    var creditAccount   = account;
                    var entitySub   = paymentObj.getValue({fieldId: 'subsidiary'});

                    // var customerObj = search.lookupFields({
					// 		type: search.Type.CUSTOMER,
					// 		id: parseInt(entityId),
					// 		columns: ['subsidiary']
				    // });
                    // var entitySub = customerObj.subsidiary[0].value
                }                

                
                
               
                log.debug("entityId",entityId);
               log.debug("debitAccount",debitAccount);
               log.debug("creditAccount",creditAccount);
               
                


                
                var curDate = formatDateTime();
                var recJE = record.create({
                    type: record.Type.JOURNAL_ENTRY,
                    isDynamic: true
                });
                
                recJE.setValue({
                    fieldId: 'subsidiary',
                    value: entitySub
                })
                if(currency_name == 'CAD')
                {
                    recJE.setValue({
                        fieldId: 'currency',
                        value: 3
                    })
                }else{
                    recJE.setValue({
                        fieldId: 'currency',
                        value: 1
                    })
                }
                recJE.setValue({
                    fieldId: 'approvalstatus',
                    value: 2
                })

                recJE.setValue({
                    fieldId: 'memo',
                    value: 'NSF Payment Reversal - '+curDate
                })
                
                //add Credit  Line
                recJE.selectNewLine({
                    sublistId: 'line',
                });
                recJE.setCurrentSublistValue({
                    sublistId: 'line',
                    fieldId: 'linesubsidiary',
                    value: entitySub
                });

                recJE.setCurrentSublistValue({
                    sublistId: 'line',
                    fieldId: 'account',
                    value: creditAccount
                });

                
                
                
                recJE.setCurrentSublistValue({
                    sublistId: 'line',
                    fieldId: 'memo',
                    value: 'NSF Payment Reversal - '+curDate
                });

                recJE.setCurrentSublistValue({
                    sublistId: 'line',
                    fieldId: 'credit',
                    value: payment_amount
                });
           

                recJE.setCurrentSublistValue({
                    sublistId: 'line',
                    fieldId: 'entity',
                    value: parseInt(entityId)
                });              
                recJE.setCurrentSublistValue({
                    sublistId: 'line',
                    fieldId: 'department',
                    value: 1
                });
                recJE.commitLine({
                    sublistId: 'line'
                });


                //add Debit  Line
                recJE.selectNewLine({
                    sublistId: 'line',
                });
                recJE.setCurrentSublistValue({
                    sublistId: 'line',
                    fieldId: 'linesubsidiary',
                    value: entitySub
                });
                recJE.setCurrentSublistValue({
                    sublistId: 'line',
                    fieldId: 'account',
                    value: debitAccount
                });
                recJE.setCurrentSublistValue({
                    sublistId: 'line',
                    fieldId: 'debit',
                    value: payment_amount
                });

            

                recJE.setCurrentSublistValue({
                    sublistId: 'line',
                    fieldId: 'entity',
                    value: parseInt(entityId)
                });
                recJE.setCurrentSublistValue({
                    sublistId: 'line',
                    fieldId: 'memo',
                    value: 'NSF Payment Reversal - '+curDate
                });             
                recJE.setCurrentSublistValue({
                    sublistId: 'line',
                    fieldId: 'department',
                    value: 1
                });
                recJE.commitLine({
                    sublistId: 'line'
                });
                recJEId = recJE.save();

                log.debug("recJEId",recJEId);
                if(paymentNo.substring(0,4) != "PYMT" && transactionType != 'customerrefund')
                {
                    var paymentObj = record.load({
                        type: record.Type.VENDOR_PAYMENT,
                        id: parseInt(payment_id)
                    });                 
                }
                else{

                    var paymentObj = record.load({
                        type: record.Type.CUSTOMER_PAYMENT,
                        id: parseInt(payment_id)
                    });  

                }




                var apply_lines = paymentObj.getLineCount({
					sublistId: 'apply'
				});


				for (var x = 0; x < apply_lines; x++)
                {	
                    paymentObj.setSublistValue({
                        sublistId: 'apply',
                        fieldId: 'apply',
                        line: x ,
                        value: false
                    });  
                }
                paymentObj.setValue({
                    fieldId: 'custbody_datetimeunapplied',
                    value: new Date()
                });

				for (var x = 0; x < apply_lines; x++)
                {	
                    var internalid = paymentObj.getSublistValue({
						sublistId: 'apply',
						fieldId: 'internalid',
						line: x 
					})
                   

                    if(recJEId == internalid)
                    {
                        
                        paymentObj.setSublistValue({
							sublistId: 'apply',
							fieldId: 'apply',
							line: x ,
							value: true
						});
                    }

                }

                paymentObj.save();
                log.debug("payment saved");

                var csvFile = file.load({ id: fileid});
                csvFile.description = 'Pending';
                csvFile.save();
            }//CUSTOMER REFUND
            else if(!isNullOrEmpty(payment_id) && transactionType == 'customerrefund'){
                log.debug('CUSTOMER REFUND')
                var transactionSearchObj = search.create({
                type: "transaction",
                filters:
                    [
                    ["numbertext","is",paymentNo], 
                    "AND", 
                    ["mainline","is","T"]
                    ],
                    columns:
                    [
                    search.createColumn({name: "internalid", label: "Internal ID"}),
                    search.createColumn({name: "accountmain", label: "Account (Main)"})
                    
                    ]
                });
                var searchResultCount = transactionSearchObj.runPaged().count;
                //log.debug("transactionSearchObj result count",searchResultCount);
                transactionSearchObj.run().each(function(result){
                    payment_id =  result.getValue({ name: 'internalid'});
                    account =  result.getValue({ name: 'accountmain'});

                    return true;
                });
                if(paymentNo.substring(0,4) != "PYMT" && transactionType == 'customerrefund')
                {
                    var paymentObj = record.load({
                        type: record.Type.CUSTOMER_REFUND,
                        id: parseInt(payment_id)
                    });
                    var payment_amount   = paymentObj.getValue({fieldId: 'total'});                         
                    var entityId   = paymentObj.getValue({fieldId: 'customer'});
                    var debitAccount   = paymentObj.getValue({fieldId: 'aracct'});
                    var creditAccount   = account;
                    var entitySub   = paymentObj.getValue({fieldId: 'subsidiary'});

                    var curDate = formatDateTime();
                    var recJE = record.create({
                        type: record.Type.JOURNAL_ENTRY,
                        isDynamic: true
                    });
                    
                    recJE.setValue({
                        fieldId: 'subsidiary',
                        value: entitySub
                    })
                    if(currency_name == 'CAD')
                    {
                        recJE.setValue({
                            fieldId: 'currency',
                            value: 3
                        })
                    }else{
                        recJE.setValue({
                            fieldId: 'currency',
                            value: 1
                        })
                    }
                    recJE.setValue({
                        fieldId: 'approvalstatus',
                        value: 2
                    })

                    recJE.setValue({
                        fieldId: 'memo',
                        value: 'NSF Payment Reversal - '+curDate
                    })
                    
                    //add debit line
                    recJE.selectNewLine({
                        sublistId: 'line',
                    });
                    recJE.setCurrentSublistValue({
                        sublistId: 'line',
                        fieldId: 'linesubsidiary',
                        value: entitySub
                    });

                    recJE.setCurrentSublistValue({
                        sublistId: 'line',
                        fieldId: 'account',
                        value: debitAccount
                    });
                    
                    recJE.setCurrentSublistValue({
                        sublistId: 'line',
                        fieldId: 'memo',
                        value: 'NSF Payment Reversal - '+curDate
                    });

                    recJE.setCurrentSublistValue({
                        sublistId: 'line',
                        fieldId: 'credit',
                        value: payment_amount
                    });
            

                    recJE.setCurrentSublistValue({
                        sublistId: 'line',
                        fieldId: 'entity',
                        value: parseInt(entityId)
                    });              
                    recJE.setCurrentSublistValue({
                        sublistId: 'line',
                        fieldId: 'department',
                        value: 1
                    });
                    recJE.commitLine({
                        sublistId: 'line'
                    });


                    //add credit  Line
                    recJE.selectNewLine({
                        sublistId: 'line',
                    });
                    recJE.setCurrentSublistValue({
                        sublistId: 'line',
                        fieldId: 'linesubsidiary',
                        value: entitySub
                    });

                    recJE.setCurrentSublistValue({
                        sublistId: 'line',
                        fieldId: 'debit',
                        value: payment_amount
                    });
                    recJE.setCurrentSublistValue({
                        sublistId: 'line',
                        fieldId: 'account',
                        value: creditAccount
                    });
                

                    recJE.setCurrentSublistValue({
                        sublistId: 'line',
                        fieldId: 'entity',
                        value: parseInt(entityId)
                    });
                    recJE.setCurrentSublistValue({
                        sublistId: 'line',
                        fieldId: 'memo',
                        value: 'NSF Payment Reversal - '+curDate
                    });             
                    recJE.setCurrentSublistValue({
                        sublistId: 'line',
                        fieldId: 'department',
                        value: 1
                    });
                    recJE.commitLine({
                        sublistId: 'line'
                    });
                    recJEId = recJE.save();

                    log.debug("recJEId",recJEId);

                    var refundObj = record.load({
                        type: record.Type.CUSTOMER_REFUND,
                        id: parseInt(payment_id)
                    }); 
                    
                    var unapplyId;
                    var transactionSublistType;
                    var apply_lines = refundObj.getLineCount({
                        sublistId: 'apply'
                    });
                    log.debug("CMapply_lines",apply_lines);
                    for (var x = 0; x < apply_lines; x++)
                    {	
                        var checkTranType = refundObj.getSublistValue({
                            sublistId: 'apply',
                            fieldId: 'type',
                            line: x 
                        })
                        log.debug("checkTranType",checkTranType);
                        if(checkTranType == 'Credit Memo' || checkTranType == 'Payment')
                        {
                            unapplyId = refundObj.getSublistValue({
                                sublistId: 'apply',
                                fieldId: 'internalid',
                                line: x
                            });
                            transactionSublistType =  checkTranType; 
                            log.debug("unapplyId",unapplyId);
                        }

                    }
                    if(!isNullOrEmpty(unapplyId))
                    {
                        var recordUnapplyObj;
                        if(transactionSublistType == 'Credit Memo')
                        {
                            recordUnapplyObj = record.load({
                                type: record.Type.CREDIT_MEMO,
                                id: parseInt(unapplyId)
                            });
                        }else{
                            recordUnapplyObj = record.load({
                                type: record.Type.CUSTOMER_PAYMENT,
                                id: parseInt(unapplyId)
                            });
                        }



                        var apply_objlines = recordUnapplyObj.getLineCount({
                            sublistId: 'apply'
                        });
                        for (var x = 0; x < apply_objlines; x++)
                        {
                            var cfObjId = recordUnapplyObj.getSublistValue({
                                            sublistId: 'apply',
                                            fieldId: 'internalid',
                                            line: x 
                                        })
                            if(payment_id == cfObjId)
                            {
                                recordUnapplyObj.setSublistValue({
                                    sublistId: 'apply',
                                    fieldId: 'apply',
                                    line: x,
                                    value: false
                                });  
                            }

                        }
                        
                        recordUnapplyObj.setValue({
                            fieldId: 'custbody_datetimeunapplied',
                            value: new Date()
                        });                        
                        var unappliedId = recordUnapplyObj.save();
                        log.debug("UNAPPLIED FROM: "+transactionSublistType,unappliedId);
                        var customerPaymentObj = record.create({
                            type: record.Type.CUSTOMER_PAYMENT,
                            isDynamic: true
                        });  
                        customerPaymentObj.setValue({
                            fieldId: 'customer',
                            value: entityId
                        })
                        customerPaymentObj.setValue({
                            fieldId: 'subsidiary',
                            value: entitySub
                        })
                        customerPaymentObj.setValue({
                            fieldId: 'payment',
                            value: payment_amount
                        })
                        if(currency_name == 'CAD')
                        {
                            customerPaymentObj.setValue({
                                fieldId: 'currency',
                                value: 3
                            })
                        }else{
                            customerPaymentObj.setValue({
                                fieldId: 'currency',
                                value: 1
                            })
                        }
                        var payment_apply_lines = customerPaymentObj.getLineCount({
                            sublistId: 'apply'
                        });                    
                        log.debug("payment_apply_lines",payment_apply_lines);
                        for (var x = 0; x < payment_apply_lines; x++)
                        {
                            var cfObjId = customerPaymentObj.getSublistValue({
                                            sublistId: 'apply',
                                            fieldId: 'internalid',
                                            line: x 
                                });
                            if(cfObjId == payment_id)
                            {
                                log.debug("CUSTOMER REFUND EQUAL");
                                var lineNum = customerPaymentObj.selectLine({
                                    sublistId: 'apply',
                                    line: x
                                });
                                customerPaymentObj.setCurrentSublistValue({
                                    sublistId: 'apply',
                                    fieldId: 'apply',
                                    value: true
                                });

                                // customerPaymentObj.setSublistValue({
                                //     sublistId: 'apply',
                                //     fieldId: 'apply',
                                //     line: x,
                                //     value: true
                                // });  
                            }
                        }

                        var credit_apply_lines = customerPaymentObj.getLineCount({
                            sublistId: 'credit'
                        });
                        for (var x = 0; x < credit_apply_lines; x++)
                        {
                            var journalObjId = customerPaymentObj.getSublistValue({
                                                sublistId: 'credit',
                                                fieldId: 'internalid',
                                                line: x 
                                });
                            if(journalObjId == recJEId)
                            {
                                log.debug("JOURNAL EQUAL");

                                var lineNum = customerPaymentObj.selectLine({
                                    sublistId: 'credit',
                                    line: x
                                });
                                customerPaymentObj.setCurrentSublistValue({
                                    sublistId: 'credit',
                                    fieldId: 'apply',
                                    value: true
                                });
                                // customerPaymentObj.setSublistValue({
                                //     sublistId: 'credit',
                                //     fieldId: 'apply',
                                //     line: x ,
                                //     value: true
                                // });  
                            }
                        } 
                        
                        var customerPaymentId = customerPaymentObj.save()
                        log.debug("CUSTOMER PAYMENT CREATED",customerPaymentId);


                    }            

                }


                var csvFile = file.load({ id: fileid});
                csvFile.description = 'Pending';
                csvFile.save();



            }

        }catch(e){
				
            log.error({
                title: e.name + ' Error',
                details: e.message
            });	

            throw e; 
        }
    }


    function summarize(summary) {
        var hasErrors = false;

        summary.reduceSummary.errors.iterator().each(function(key, error) {
            log.error({ title: 'Reduce Error', details: key + ': ' + error });
            hasErrors = true;
            return true;
        });
        if(hasErrors == false)
        {
            var file_id;
            var fileSearchObj = search.create({
                type: "file",
                filters:
                [
                ["folder","anyof","329224"]
                ],
                columns:
                [
                search.createColumn({name: "internalid", label: "Internal ID"}),
                ]
            });
            var searchResultCount = fileSearchObj.runPaged().count;
            log.debug("fileSearchObj result count",searchResultCount);
            fileSearchObj.run().each(function(result){
                file_id =  result.getValue({ name: 'internalid'});
                return true;
            });
            if(searchResultCount > 0)
            {
                var file_obj = file.load({
                    id: file_id
                });
                file_obj.description = 'Completed';
                file_obj.folder = 329225;

                file_obj.save();
            }
        }
       



    }

    function isNullOrEmpty(objVariable) 
    {
        return (objVariable == null || objVariable == "" || objVariable == undefined || objVariable == 'undefined' || objVariable == 0);
    }

	function formatDateTime() {
	
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

    return {
        getInputData: getInputData,
        reduce: reduce,
        summarize: summarize
    };
});