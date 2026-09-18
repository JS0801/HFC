/**
* @NApiVersion 2.1
* @NModuleScope Public
*/

define(['N/ui/serverWidget', 'N/runtime', 'N/redirect', 'N/search', 'N/record', 'N/task', 'N/format', 'N/file', 'N/email', 'N/url', 'N/render', 'N/xml', 'N/https'],
    function (serverWidget, runtime, redirect, search, record, task, format, file, email, url, render, xml, https) {

        function getLatestCustomerTransactionDate(customerId) {
            var results = search.create({
                type: search.Type.TRANSACTION,
                filters: [
                    ['entity', 'anyof', customerId],
                    'AND',
                    ['mainline', 'is', 'T'],
                    'AND',
                    ['posting', 'is', 'T']
                ],
                columns: [
                    search.createColumn({
                        name: 'trandate',
                        sort: search.Sort.DESC
                    })
                ]
            }).run().getRange({
                start: 0,
                end: 1
            });

            if (!results || !results.length) {
                return null;
            }

            return results[0].getValue({ name: 'trandate' });
        }

        function isNullOrEmpty(objVariable) {
            return (objVariable == null || objVariable == "" || objVariable == undefined || objVariable == 'undefined' || objVariable == 0);
        };

        function pickTag(xmlStr, tagName) {
            var re = new RegExp('<' + tagName + '>([\\s\\S]*?)<\\/' + tagName + '>', 'i');
            var m = re.exec(xmlStr || '');
            return (m && m[1] != null) ? String(m[1]).trim() : '';
        }

        // Handles both ISO (YYYY-MM-DD) and MM/DD/YYYY — NetSuite search results
        // often return ISO format which caused everything to fall into 'over90'
        // function getAgingBucket(dueDateStr) {
        //   log.debug('dueDateStr',dueDateStr)
        //     if (!dueDateStr) return 'over90';

        //     var year, month, day;

        //     if (dueDateStr.indexOf('-') !== -1) {
        //         var parts = dueDateStr.split('-');
        //         if (parts.length !== 3) return 'over90';
        //         year  = parseInt(parts[0]);
        //         month = parseInt(parts[1]) - 1;
        //         day   = parseInt(parts[2]);
        //     } else {
        //         var parts = dueDateStr.split('/');
        //         if (parts.length !== 3) return 'over90';
        //         month = parseInt(parts[0]) - 1;
        //         day   = parseInt(parts[1]);
        //         year  = parseInt(parts[2]);
              
        //     }
        //     var dueDate = month+'/'+day+'/'+year
        //      dueDate = new Date(dueDate);
        //     var todayStr = mmddyyyy();
        //     var tp = todayStr.split('/');
        //   log.debug('tp',tp)
        //     var today = new Date(parseInt(tp[2]), parseInt(tp[0]) - 1, parseInt(tp[1]));
        //   log.debug('today',today)
        //   log.debug('dueDate',dueDate)
        //   log.debug('dueDate',Math.floor(dueDate))

        //     var diffDays = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));

        //     log.debug('getAgingBucket-detail', {
        //         dueDateStr: dueDateStr,
        //         parsedYear: year, parsedMonth: month, parsedDay: day,
        //         dueDateObj: dueDate.toString(),
        //         todayStr:   todayStr,
        //         todayObj:   today.toString(),
        //         diffDays:   diffDays
        //     });

        //     if (diffDays <= 0)  return 'current';
        //     if (diffDays <= 30) return 'days1_30';
        //     if (diffDays <= 60) return 'days31_60';
        //     if (diffDays <= 90) return 'days61_90';
        //     return 'over90';
        // }

       function getAgingBucket(dueDateStr) {
            if (!dueDateStr) return 'over90';
 
            var year, month, day;
 
            if (dueDateStr.indexOf('-') !== -1) {
                var parts = dueDateStr.split('-');
                if (parts.length !== 3) return 'over90';
                year  = parseInt(parts[0], 10);
                month = parseInt(parts[1], 10) - 1;
                day   = parseInt(parts[2], 10);
            } else {
                var parts = dueDateStr.split('/');
                if (parts.length !== 3) return 'over90';
                month = parseInt(parts[0], 10) - 1;
                day   = parseInt(parts[1], 10);
                year  = parseInt(parts[2], 10);
            }
 
            // Build Date directly from integers — never pass a string to new Date()
            // as older JS engines (Rhino) may fail to parse it
            var dueDate = new Date(year, month, day);
 
            var todayStr = mmddyyyy();
            var tp = todayStr.split('/');
            var today = new Date(parseInt(tp[2], 10), parseInt(tp[0], 10) - 1, parseInt(tp[1], 10));
 
            var diffDays = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
 
            if (diffDays <= 0)  return 'current';
            if (diffDays <= 30) return 'days1_30';
            if (diffDays <= 60) return 'days31_60';
            if (diffDays <= 90) return 'days61_90';
            return 'over90';
        }

        function buildSummaryTable(rows, labelHeader) {
            var grandCurrent = 0, grand1_30 = 0, grand31_60 = 0, grand61_90 = 0, grandOver90 = 0;
            var html = "<table class='sublist' style='width: 100%; margin-top: 20px; border-collapse: collapse;'>";
            html += "<thead><tr style='background-color: #e3e3e3;'>";
            html += "<th align='left'   style='font-size: 8px; padding: 2px 4px;'>" + labelHeader + "</th>";
            html += "<th align='center' style='font-size: 8px; padding: 2px 4px;'>Current</th>";
            html += "<th align='center' style='font-size: 8px; padding: 2px 4px;'>1-30 Days</th>";
            html += "<th align='center' style='font-size: 8px; padding: 2px 4px;'>31-60 Days</th>";
            html += "<th align='center' style='font-size: 8px; padding: 2px 4px;'>61-90 Days</th>";
            html += "<th align='center' style='font-size: 8px; padding: 2px 4px;'>Over 90 Days</th>";
            html += "<th align='center' style='font-size: 8px; padding: 2px 4px;'>Total</th>";
            html += "</tr></thead>";
            for (var i = 0; i < rows.length; i++) {
                var r = rows[i];
                var rowTotal = r.current + r.days1_30 + r.days31_60 + r.days61_90 + r.over90;
                grandCurrent += r.current;
                grand1_30 += r.days1_30;
                grand31_60 += r.days31_60;
                grand61_90 += r.days61_90;
                grandOver90 += r.over90;
                html += "<tr>";
                html += "<td align='left'   style='font-size: 7px; padding: 2px 4px;'>" + checkAmper(r.label) + "</td>";
                html += "<td align='right'  style='font-size: 7px; padding: 2px 4px;'>" + commafy(r.current) + "</td>";
                html += "<td align='right'  style='font-size: 7px; padding: 2px 4px;'>" + commafy(r.days1_30) + "</td>";
                html += "<td align='right'  style='font-size: 7px; padding: 2px 4px;'>" + commafy(r.days31_60) + "</td>";
                html += "<td align='right'  style='font-size: 7px; padding: 2px 4px;'>" + commafy(r.days61_90) + "</td>";
                html += "<td align='right'  style='font-size: 7px; padding: 2px 4px;'>" + commafy(r.over90) + "</td>";
                html += "<td align='right'  style='font-size: 7px; padding: 2px 4px; font-weight: bold;'>" + commafy(rowTotal) + "</td>";
                html += "</tr>";
            }
            var grandTotal = grandCurrent + grand1_30 + grand31_60 + grand61_90 + grandOver90;
            html += "<tr style='background-color: #e3e3e3; font-weight: bold;'>";
            html += "<td align='left'   style='font-size: 7px; padding: 2px 4px;'>Grand Total</td>";
            html += "<td align='right'  style='font-size: 7px; padding: 2px 4px;'>" + commafy(grandCurrent) + "</td>";
            html += "<td align='right'  style='font-size: 7px; padding: 2px 4px;'>" + commafy(grand1_30) + "</td>";
            html += "<td align='right'  style='font-size: 7px; padding: 2px 4px;'>" + commafy(grand31_60) + "</td>";
            html += "<td align='right'  style='font-size: 7px; padding: 2px 4px;'>" + commafy(grand61_90) + "</td>";
            html += "<td align='right'  style='font-size: 7px; padding: 2px 4px;'>" + commafy(grandOver90) + "</td>";
            html += "<td align='right'  style='font-size: 7px; padding: 2px 4px;'>" + commafy(grandTotal) + "</td>";
            html += "</tr></table>";
            return html;
        }


        function buildXML(id, req, sub) {
            var DEBUG_IDENTIFIER = 'buildXML';
            var record_id = id;
            log.debug('recordid: ', id)

            // DEBUG: check what date NetSuite thinks today is
            var _d = new Date();
            log.debug('today-check', {
                newDateToString:  _d.toString(),
                newDateGetTime:   _d.getTime(),
                getFullYear:      _d.getFullYear(),
                getMonth:         _d.getMonth(),
                getDate:          _d.getDate(),
                mmddyyyy:         mmddyyyy()
            });

            var arrayinfo = [];

            var territoryMap = {};
            var descriptionMap = {};

            function addToBucket(map, key, label, bucket, amt) {
                if (!map[key]) {
                    map[key] = { label: label, current: 0, days1_30: 0, days31_60: 0, days61_90: 0, over90: 0 };
                }
                map[key][bucket] += parseFloat(amt) || 0;
            }

            var cusObj = record.load({
                type: record.Type.CUSTOMER,
                id: record_id
            });
            log.debug('cusObj', cusObj)

            var lineCount = cusObj.getLineCount({
                sublistId: 'addressbook'
            });

            log.debug('lineCount: ', lineCount);

            var cus_country = ""
            var cus_addr1 = ""
            var cus_city = ""
            var cus_state = ""
            var cus_zip = ""
            var cus_addressee = ""

            if (lineCount > 0) {
                var addressSubrec = cusObj.getSublistSubrecord({
                    sublistId: 'addressbook',
                    fieldId: 'addressbookaddress',
                    line: 0
                });

                cus_addressee = addressSubrec.getValue({ fieldId: 'addressee' });
                cus_country = addressSubrec.getValue({ fieldId: 'country' });
                cus_addr1 = addressSubrec.getValue({ fieldId: 'addr1' });
                cus_city = addressSubrec.getValue({ fieldId: 'city' });
                cus_state = addressSubrec.getValue({ fieldId: 'state' });
                cus_zip = addressSubrec.getValue({ fieldId: 'zip' });
            }

            var entityId = cusObj.getValue({ fieldId: 'entityid' });
            var parentId = cusObj.getValue({ fieldId: 'custentity_ne_cust_parent_id' });
            var checkParent = cusObj.getValue({ fieldId: 'parent' });

            var primaryCurrency = cusObj.getValue({ fieldId: 'currency' });
            var primaryCurrencyText = cusObj.getText({ fieldId: 'currency' });
            var isParent = false;
            var customerRecordIds = [];
            customerRecordIds.push(record_id)
            log.debug('check', checkParent)
            if (isNullOrEmpty(checkParent)) {
                isParent = true;
                log.debug('isParent', isParent);
                var customerSearchObj = search.create({
                    type: "customer",
                    filters: [
                        search.createFilter({
                            name: 'formulatext',
                            formula: '{parentcustomer.internalid}',
                            operator: search.Operator.IS,
                            values: record_id
                        })
                    ],
                    columns: [
                        search.createColumn({ name: "internalid", label: "Internal ID" }),
                    ]
                });
                var searchResultCount = customerSearchObj.runPaged().count;
                log.debug("customerSearchObj result count", searchResultCount);
                customerSearchObj.run().each(function (result) {
                    var custInternalId = result.getValue({ name: 'internalid' });
                    log.debug('custInternalId', custInternalId);
                    if (record_id != custInternalId) {
                        customerRecordIds.push(parseInt(custInternalId));
                    }
                    return true;
                });
            }
            log.debug('customerRecordIds', customerRecordIds);

            var subId = cusObj.getValue({ fieldId: 'subsidiary' });
            var subObj = record.load({
                type: record.Type.SUBSIDIARY,
                id: subId,
                isDynamic: true
            });
            var subLogo = subObj.getValue({ fieldId: 'logo' });
            var applyRatio = false;
            var subName = subObj.getValue({ fieldId: 'name' });
            var mainAddressSubrec = subObj.getSubrecord({ fieldId: 'mainaddress' });

            var addr1 = mainAddressSubrec.getValue('addr1');
            var city = mainAddressSubrec.getValue('city');
            var state = mainAddressSubrec.getValue('state');
            var zip = mainAddressSubrec.getValue('zip');
            var country = mainAddressSubrec.getValue('country');

            var loadedFile = file.load({ id: subLogo });
            var fileUrl = loadedFile.url;

            var currenciesCheck = [];
            var currencies = [];
            var checkCurrency = search.load({ id: 'customsearch_ne_ar_open_balance' });
            if (customerRecordIds.length > 0) {
                var filter = search.createFilter({ name: "name", operator: search.Operator.ANYOF, values: customerRecordIds });
                checkCurrency.filters.push(filter);
            }

            var openBalanceSearch = search.load({ id: 'customsearch_ne_ar_open_balance' });
            if (customerRecordIds.length > 0) {
                var filter = search.createFilter({ name: "name", operator: search.Operator.ANYOF, values: customerRecordIds });
                openBalanceSearch.filters.push(filter);
            }

            var result_set = openBalanceSearch.run();
            var current_range = result_set.getRange({ start: 0, end: 1000 });
            var i = 0;
            var j = 0;

            while (j < current_range.length) {
                var result = current_range[j];

                var brandName             = result.getText(result_set.columns[0])  || '';
                var customerName          = result.getText(result_set.columns[2])  || '';
                var customerAddress       = result.getValue(result_set.columns[3]) || '';
                var feNumber              = result.getValue(result_set.columns[4]) || '';
                var itemName              = result.getText(result_set.columns[5])  || '';
                var invoiceNo             = result.getValue(result_set.columns[6]) || '';
                var invoiceDate           = result.getValue(result_set.columns[7]) || '';
                var dueDate               = result.getValue(result_set.columns[8]) || '';
                var poNumber              = result.getValue(result_set.columns[9]) || '';
                var amount                = result.getValue(result_set.columns[10]) || '';
                var totalAmountItemSearch = result.getValue(result_set.columns[11]) || '';
                var totalPercent          = result.getValue(result_set.columns[12]) || '';
                var currencyColumn        = result.getValue(result_set.columns[13]) || '';
                var internalId            = result.getValue(result_set.columns[14]) || '';
                var territory             = result.getValue(result_set.columns[15]) || '';
                var lineId                = result.getValue(result_set.columns[16]) || '';

                arrayinfo.push({
                    "brandName": brandName,
                    "customerName": customerName,
                    "customerAddress": customerAddress,
                    "feNumber": feNumber,
                    "itemName": itemName,
                    "invoiceNo": invoiceNo,
                    "invoiceDate": invoiceDate,
                    "dueDate": dueDate,
                    "poNumber": poNumber,
                    "amount": amount,
                    "totalPercent": totalPercent,
                    "currencyColumn": currencyColumn,
                    "internal_id": internalId,
                    "territory": territory,
                    "lineId": lineId,
                    "totalAmountItemSearch": totalAmountItemSearch
                });
                j++;
                i++;
                if (j == 1000) {
                    j = 0;
                    current_range = result_set.getRange({ start: i, end: i + 1000 });
                }
            }

            var searchResultCount = openBalanceSearch.runPaged().count;
            log.debug('searchResultCount', searchResultCount)

            var setName = ""
            var setAddress = ""
            var setFe = ""

            if (searchResultCount > 0) {
                setName = arrayinfo[0].customerName;
                setAddress = arrayinfo[0].customerAddress;
                if (entityId == parentId) {
                    setFe = parentId;
                } else {
                    setFe = arrayinfo[0].feNumber;
                }
            }

            var amountArray = [];
            var amountSearch = search.load({ id: 'customsearch_ne_ar_open_balance_amt' });
            if (customerRecordIds.length > 0) {
                var filter = search.createFilter({ name: "name", operator: search.Operator.ANYOF, values: customerRecordIds });
                amountSearch.filters.push(filter);
            }

            var result_set = amountSearch.run();
            var current_range = result_set.getRange({ start: 0, end: 1000 });
            var i = 0;
            var j = 0;

            while (j < current_range.length) {
                var result = current_range[j];
                var transType   = result.getValue(result_set.columns[1])  || null;
                var invoiceNo   = result.getValue(result_set.columns[5])  || null;
                var itemAmount  = result.getValue(result_set.columns[9])  || null;
                var internal_id = result.getValue(result_set.columns[11]) || null;
                var amtLineId   = result.getValue(result_set.columns[14]) || null;
                var companyName = result.getText(result_set.columns[15])  || null;

                amountArray.push({
                    "transType": transType,
                    "invoiceNo": invoiceNo,
                    "itemAmount": itemAmount,
                    'internal_id': internal_id,
                    "amtLineId": amtLineId,
                    "companyName": companyName
                });
                j++;
                i++;
                if (j == 1000) {
                    j = 0;
                    current_range = result_set.getRange({ start: i, end: i + 1000 });
                }
            }
            var amountSearchResultCount = amountSearch.runPaged().count;
            log.debug('amountSearchResultCount', amountSearchResultCount)

            var xml_body = "<?xml version=\"1.0\"?>\n<!DOCTYPE pdf PUBLIC \"-//big.faceless.org//report\" \"report-1.1.dtd\">\n";
            xml_body += "<pdf>";
            xml_body += "<head>";
            xml_body += "<style>"
            xml_body += "th,td{padding: 1px;}"
            xml_body += ".sublist,.sublist th,.sublist td { border: 0.1px solid #444444; table-layout: fixed;  word-wrap:break-word;}"
            xml_body += "thead {  background:  color: #FFFFFF; align: center;font-weight:bold }"
            xml_body += "</style>"
            xml_body += "</head>"
            xml_body += "\n<body font-family='Arial, Helvetica, sans-serif' font-size=\"8\" size=\"A4\">\n";

            var totalBalance = 0;
            xml_body += "<table style='width: 100%;'>"
            xml_body += "<tr>"
            if (applyRatio) {
                if (subId == 92)            xml_body += "<td align='Left' style='width: 470px;'><img width='80px'  height='72px'   src='" + checkAmper(fileUrl) + "'/></td>"
                else if (subId == 98)       xml_body += "<td align='Left' style='width: 470px;'><img width='80px'  height='50px'   src='" + checkAmper(fileUrl) + "'/></td>"
                else if (subId==84||subId==85) xml_body += "<td align='Left' style='width: 470px;'><img width='110px' height='61px'   src='" + checkAmper(fileUrl) + "'/></td>"
                else                        xml_body += "<td align='Left' style='width: 470px;'><img width='110px' height='31.5px' src='" + checkAmper(fileUrl) + "'/></td>"
            } else {
                if (subId == 92)            xml_body += "<td align='Left' style='width: 470px;'><img width='80px'  height='72px'  src='" + checkAmper(fileUrl) + "'/></td>"
                else if (subId == 80)       xml_body += "<td align='Left' style='width: 470px;'><img width='150px' height='60px'  src='" + checkAmper(fileUrl) + "'/></td>"
                else                        xml_body += "<td align='Left' style='width: 470px;'><img src='" + checkAmper(fileUrl) + "'/></td>"
            }

            xml_body += "<td align='Right' style='width: 473px;'>"
            xml_body += "<table style='width: 100%;'>"
            xml_body += "<tr>"
            xml_body += "<td style='text-align:right;font-weight:bold;white-space: nowrap; padding-left: 300px; font-size:12px' align = 'right'>Statement Date:</td>"
            xml_body += "<td align='right' style='text-align:right;padding-left: 110px; font-size:12px'>" + formatDate() + "</td>"
            xml_body += "</tr>"
            xml_body += "<tr>"
            xml_body += "<td style='text-align:right;font-weight:bold;white-space: nowrap; padding-left: 300px; font-size:12px' align = 'right'>Currency:</td>"
            xml_body += "<td align='right' style='text-align:right;padding-left: 110px; font-size:12px;white-space: nowrap;'>" + primaryCurrencyText + "</td>"
            xml_body += "</tr>"
            xml_body += "</table>"
            xml_body += "</td>"
            xml_body += "</tr>"
            xml_body += "<tr>"
            xml_body += "<td style='font-size: 24pt; padding-top: 10px;' colspan = '2' align = 'center' >Statement</td>"
            xml_body += "</tr>"
            xml_body += "</table>"

            xml_body += "<table style = 'padding-top: 1px; width: 50%;'>"
            xml_body += "<tr>"
            xml_body += "<td align ='left' style='font-size: 12px'>" + checkAmper(subName) + "<br/>" + checkAmper(addr1) + "<br/>" + checkAmper(city) + " " + checkAmper(state) + " " + checkAmper(zip) + "<br/>United States</td>"
            xml_body += "</tr>"
            xml_body += "</table>"

            xml_body += "<table style = 'padding-top: 20px; width: 50%;'>"
            xml_body += "<tr>"
            xml_body += "<td align ='left' style='font-size: 12px'>" + checkAmper(cus_addressee) + "<br/>" + checkAmper(cus_addr1) + "<br/>" + checkAmper(cus_city) + " " + checkAmper(cus_state) + " " + checkAmper(cus_zip) + "</td>"
            xml_body += "</tr>"
            xml_body += "<tr>"
            xml_body += "<td align ='left' style='font-size: 12px'>FE #: " + checkAmper(setFe) + "</td>"
            xml_body += "</tr>"
            xml_body += "</table>"

            xml_body += "<table  style='width: 100%;padding-top: 30px'>"
            xml_body += "<thead>"
            xml_body += "<tr style='background-color: #e3e3e3;'>"
            xml_body += "<th colspan='5' align='left'  style='font-size: 8px;'>TERRITORY #</th>"
            xml_body += "<th colspan='5' align='left'  style='font-size: 8px'>COMPANY</th>"
            xml_body += "<th colspan='5' align='left'  style='font-size: 8px'>DESCRIPTION</th>"
            xml_body += "<th colspan='5'               style='font-size: 8px'>INVOICE #</th>"
            xml_body += "<th colspan='3'               style='font-size: 8px'>INVOICE DATE</th>"
            xml_body += "<th colspan='2' align='left'  style='font-size: 8px'>DUE DATE</th>"
            xml_body += "<th colspan='4' align='center' style='font-size: 8px'>PO #</th>"
            xml_body += "<th colspan='5' align='right' style='font-size: 8px'>AMOUNT</th>"
            xml_body += "</tr>"
            xml_body += "</thead>"

            if (amountSearchResultCount > 0) {
                var totalAmount;
                for (var i = 0; i < amountArray.length; i++) {
                    for (var x = 0; x < arrayinfo.length; x++) {
                        if (primaryCurrency == arrayinfo[x].currencyColumn) {
                            if (arrayinfo[x].internal_id == amountArray[i].internal_id && amountArray[i].transType != 'Journal' || arrayinfo[x].internal_id == amountArray[i].internal_id && amountArray[i].transType == 'Journal' && arrayinfo[x].lineId == amountArray[i].amtLineId) {
                               var finalDueDate = arrayinfo[x].dueDate || arrayinfo[x].invoiceDate;
                                var bucket  = getAgingBucket(finalDueDate);
                                var terrKey = arrayinfo[x].territory || 'Unknown';
                                var descKey = arrayinfo[x].itemName  || 'Unknown';

                                if (!isNullOrEmpty(arrayinfo[x].totalPercent)) {
                                    xml_body += "<tr>"
                                    xml_body += "<td colspan='5' align='left'  style='font-size: 7px'>" + checkAmper(arrayinfo[x].territory) + "</td>"
                                    xml_body += "<td colspan='5' align='left'  style='font-size: 7px'>" + checkAmper(amountArray[i].companyName) + "</td>"
                                    xml_body += "<td colspan='5' align='left'  style='font-size: 7px'>" + checkAmper(arrayinfo[x].itemName) + "</td>"
                                    xml_body += "<td colspan='5'               style='font-size: 7px'>" + checkAmper(arrayinfo[x].invoiceNo) + "</td>"
                                    xml_body += "<td colspan='3'               style='font-size: 7px'>" + arrayinfo[x].invoiceDate + "</td>"
                                    xml_body += "<td colspan='2' align='left'  style='font-size: 7px'>" + arrayinfo[x].dueDate + "</td>"
                                    xml_body += "<td colspan='4' align='right' style='font-size: 7px'>" + checkAmper(arrayinfo[x].poNumber) + "</td>"

                                    // Path A: totals match — use direct amount
                                    // Path B: trust direct line amount over % calc
                                    // if (arrayinfo[x].totalAmountItemSearch == amountArray[i].itemAmount) {
                                    //     totalAmount = parseFloat(arrayinfo[x].amount);
                                    // } else {
                                    //     var actualAmt = parseFloat(arrayinfo[x].amount);
                                    //     if (!isNaN(actualAmt) && actualAmt !== 0) {
                                    //         totalAmount = actualAmt;
                                    //     } else {
                                    //         totalAmount = (parseFloat(arrayinfo[x].totalPercent) / 100) * parseFloat(amountArray[i].itemAmount);
                                    //     }
                                    // }

                                   if (arrayinfo[x].totalAmountItemSearch == amountArray[i].itemAmount) {
                                        totalAmount = + arrayinfo[x].amount;
                                    } else {
                                        // totalAmount = (parseFloat(arrayinfo[x].totalPercent)/100) * parseFloat(amountArray[i].itemAmount)

                                        var computed = (parseFloat(arrayinfo[x].totalPercent) / 100) * parseFloat(amountArray[i].itemAmount);
                                        var actualAmt = parseFloat(arrayinfo[x].amount);

                                        // Preserve the sign of the real line amount
                                        if (!isNaN(actualAmt) && actualAmt < 0) {
                                            computed = -Math.abs(computed);
                                        }
                                        totalAmount = computed;
                                    }

                                    log.debug('amt-debug', {
                                        invoice: arrayinfo[x].invoiceNo,
                                        internal_id: arrayinfo[x].internal_id,
                                        amount_from_arrayinfo: arrayinfo[x].amount,
                                        totalPercent: arrayinfo[x].totalPercent,
                                        totalAmountItemSearch: arrayinfo[x].totalAmountItemSearch,
                                        itemAmount_from_amountArray: amountArray[i].itemAmount,
                                        computed_totalAmount: totalAmount,
                                        path: arrayinfo[x].totalAmountItemSearch == amountArray[i].itemAmount ? 'A' : 'B'
                                    });

                                    xml_body += "<td colspan='5' align='right' style='font-size: 7px'>" + commafy(totalAmount) + "</td>"
                                    xml_body += "</tr>"

                                    addToBucket(territoryMap,   terrKey, terrKey, bucket, totalAmount);
                                    addToBucket(descriptionMap, descKey, descKey, bucket, totalAmount);
                                    log.debug('dueDate-raw', { dueDate: arrayinfo[x].dueDate, bucket: bucket });

                                } else {
                                    // Path C: no totalPercent — use direct line amount (discounts, credits etc.)
                                    var lineAmt = parseFloat(arrayinfo[x].amount) || 0;

                                    xml_body += "<tr>"
                                    xml_body += "<td colspan='5' align='left'  style='font-size: 7px'>" + checkAmper(arrayinfo[x].territory) + "</td>"
                                    xml_body += "<td colspan='5' align='left'  style='font-size: 7px'>" + checkAmper(amountArray[i].companyName) + "</td>"
                                    xml_body += "<td colspan='5' align='left'  style='font-size: 7px'>" + checkAmper(arrayinfo[x].itemName) + "</td>"
                                    xml_body += "<td colspan='5'               style='font-size: 7px'>" + checkAmper(arrayinfo[x].invoiceNo) + "</td>"
                                    xml_body += "<td colspan='3'               style='font-size: 7px'>" + arrayinfo[x].invoiceDate + "</td>"
                                    xml_body += "<td colspan='2' align='left'  style='font-size: 7px'>" + arrayinfo[x].dueDate + "</td>"
                                    xml_body += "<td colspan='4' align='right' style='font-size: 7px'>" + checkAmper(arrayinfo[x].poNumber) + "</td>"
                                    xml_body += "<td colspan='5' align='right' style='font-size: 7px'>" + commafy(lineAmt) + "</td>"
                                    xml_body += "</tr>"

                                    addToBucket(territoryMap,   terrKey, terrKey, bucket, lineAmt);
                                    addToBucket(descriptionMap, descKey, descKey, bucket, lineAmt);
                                    log.debug('dueDate-raw', { dueDate: arrayinfo[x].dueDate, bucket: bucket });
                                }
                            }
                        }
                    }
                }
            }

            xml_body += "</table>"

            var totalBalance = 0;
            if (entityId == parentId || isNullOrEmpty(checkParent)) {
                var totalBalanceSearch = search.load({ id: 'customsearch_ne_parent_cus_statement_lis' });
                var filterSearch1 = search.createFilter({ name: "internalid", operator: search.Operator.ANYOF, values: record_id });
                totalBalanceSearch.filters.push(filterSearch1);
                var searchResultCount = totalBalanceSearch.runPaged().count;
                log.debug("totalBalanceSearch result count", searchResultCount);
                totalBalanceSearch.run().each(function (result) {
                    totalBalance = result.getValue({ name: 'formulacurrency' });
                    return true;
                });
            } else {
                var totalBalanceSearch = search.load({ id: 'customsearch_ne_child_cus_statement' });
                var filterSearch1 = search.createFilter({ name: "internalid", operator: search.Operator.ANYOF, values: record_id });
                totalBalanceSearch.filters.push(filterSearch1);
                var searchResultCount = totalBalanceSearch.runPaged().count;
                log.debug("totalBalanceSearch result count", searchResultCount);
                totalBalanceSearch.run().each(function (result) {
                    totalBalance = result.getValue({ name: 'fxbalance' });
                    return true;
                });
            }

            xml_body += "<table style='page-break-inside: avoid; width: 100%; margin-top: 10px;'>"
            xml_body += "<tr style='background-color: #e3e3e3; line-height: 200%;'>"
            xml_body += "<td background-color='#ffffff' colspan='5'></td>"
            xml_body += "<td align='right' style='font-weight: bold; color: #333333;'>Total Open Balance</td>"
            xml_body += "<td align='right'>" + commafy(totalBalance) + "</td>"
            xml_body += "</tr>"
            xml_body += "</table>"

            try {
                var consolidate = !checkParent;
                log.debug('Render Statement', { custId: record_id, consolidate: consolidate });

                var customerId = parseInt(record_id, 10);
                var dateNew = mmddyyyy();
                log.audit('dateNew', dateNew)

                var renderedFile = render.statement({
                    entityId: customerId,
                    printMode: render.PrintMode.HTML,
                    consolidateStatements: consolidate,
                    inCustLocale: false,
                    statementDate: dateNew
                });
                log.debug('Statement Obj', {
                    entityId: customerId,
                    consolidateStatements: consolidate,
                    inCustLocale: false,
                    statementDate: dateNew
                });

                var rawContent = renderedFile.getContents();
                var htmlContent = tryDecode(rawContent);

                log.debug('Render Result', { custId: record_id, contentLength: htmlContent.length });

                var aging = extractAgingFromHtml(htmlContent);

                if (!aging) {
                    log.debug('Aging extraction failed', { custId: record_id, sample: htmlContent.substring(0, 1000) });
                    var vals = { consolaging: 0, consolaging1: 0, consolaging2: 0, consolaging3: 0, consolaging4: 0 };
                } else {
                    log.debug('aging', aging)
                    var vals = {
                        consolaging:  aging.current  || 0,
                        consolaging1: aging.d30      || 0,
                        consolaging2: aging.d60      || 0,
                        consolaging3: aging.d90      || 0,
                        consolaging4: aging.d90plus  || 0
                    };
                }

                log.debug('Customer Consol Aging (HTML render)', {
                    custId: record_id,
                    consolaging:  vals.consolaging,
                    consolaging1: vals.consolaging1,
                    consolaging2: vals.consolaging2,
                    consolaging3: vals.consolaging3,
                    consolaging4: vals.consolaging4
                });

            } catch (error) {
                log.debug('error', error);
                var vals = { consolaging: 0, consolaging1: 0, consolaging2: 0, consolaging3: 0, consolaging4: 0 };
            }

            xml_body += "<table  style='width: 100%;padding-top: 30px'>"
            xml_body += "<thead>"
            xml_body += "<tr style='background-color: #e3e3e3;'>"
            xml_body += "<th colspan='5' align='center' style='font-size: 8px;'>Consolidated Current</th>"
            xml_body += "<th colspan='5' align='center' style='font-size: 8px'>1-30 Days</th>"
            xml_body += "<th colspan='5' align='center' style='font-size: 8px'>31-60 Days</th>"
            xml_body += "<th colspan='5' align='center' style='font-size: 8px'>61-90 Days</th>"
            xml_body += "<th colspan='5' align='center' style='font-size: 8px'>Over 90 Days</th>"
            xml_body += "</tr>"
            xml_body += "</thead>"
            xml_body += "<tr>"
            xml_body += "<td colspan='5' align='center' style='font-size: 7px'>" + commafy(vals.consolaging)  + "</td>"
            xml_body += "<td colspan='5' align='center' style='font-size: 7px'>" + commafy(vals.consolaging1) + "</td>"
            xml_body += "<td colspan='5' align='center' style='font-size: 7px'>" + commafy(vals.consolaging2) + "</td>"
            xml_body += "<td colspan='5' align='center' style='font-size: 7px'>" + commafy(vals.consolaging3) + "</td>"
            xml_body += "<td colspan='5' align='center' style='font-size: 7px'>" + commafy(vals.consolaging4) + "</td>"
            xml_body += "</tr>"
            xml_body += "</table>"

            var territoryRows = [];
            for (var tKey in territoryMap) {
                if (territoryMap.hasOwnProperty(tKey)) {
                    territoryRows.push(territoryMap[tKey]);
                }
            }
            territoryRows.sort(function (a, b) { return a.label < b.label ? -1 : a.label > b.label ? 1 : 0; });
            if (territoryRows.length > 0) {
                xml_body += "<table style='width: 100%; margin-top: 20px;'>";
                xml_body += "<tr><td style='font-size: 9px; font-weight: bold; padding-bottom: 2px;'>Summary by Territory</td></tr>";
                xml_body += "</table>";
                xml_body += buildSummaryTable(territoryRows, 'Territory #');
            }

            var descriptionRows = [];
            for (var dKey in descriptionMap) {
                if (descriptionMap.hasOwnProperty(dKey)) {
                    descriptionRows.push(descriptionMap[dKey]);
                }
            }
            descriptionRows.sort(function (a, b) { return a.label < b.label ? -1 : a.label > b.label ? 1 : 0; });
            if (descriptionRows.length > 0) {
                xml_body += "<table style='width: 100%; margin-top: 20px;'>";
                xml_body += "<tr><td style='font-size: 9px; font-weight: bold; padding-bottom: 2px;'>Summary by Description</td></tr>";
                xml_body += "</table>";
                xml_body += buildSummaryTable(descriptionRows, 'Description');
            }

            if (subId != 63) {
                var subEmail = subObj.getValue({ fieldId: 'custrecord_ne_statement_email' });
                if (!isNullOrEmpty(subEmail)) {
                    subEmail = subEmail
                } else {
                    subEmail = ""
                }
            }

            xml_body += "</body>\n</pdf>";
            return xml_body;
        }


        function commafy(x) {
            x = parseFloat(x).toFixed(2)
            return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        }

        function checkAmper(y) {
            if (y.indexOf('&') != -1) {
                var y = y.replace(/&/g, "&amp;")
            }
            return y;
        }

        function formatDate() {
            var current_date = new Date();
            var trandate = current_date.getDate();
            var tranmonth = current_date.getMonth() + 1;
            var tranyear = current_date.getFullYear();
            if (trandate < 10) { trandate = '0' + trandate; }
            if (tranmonth < 10) { tranmonth = '0' + tranmonth; }
            return tranmonth + '/' + trandate + '/' + tranyear;
        }

        function numberWithCommas(x) {
            x = x.toFixed(2);
            return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        }

        function tryDecode(content) {
            if (!content) return '';
            var sample = content.substring(0, 500);
            var looksLikeBase64 = /^[A-Za-z0-9+/=\s]+$/.test(sample) && !/<\w+/.test(sample);
            if (looksLikeBase64) {
                try { if (typeof atob === 'function') return atob(content.replace(/\s/g, '')); } catch (e) { }
                return manualBase64Decode(content);
            }
            return content;
        }

        function manualBase64Decode(b64) {
            var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
            var str = b64.replace(/[^A-Za-z0-9+/=]/g, ''), out = '', i = 0;
            while (i < str.length) {
                var e1 = chars.indexOf(str.charAt(i++)), e2 = chars.indexOf(str.charAt(i++)),
                    e3 = chars.indexOf(str.charAt(i++)), e4 = chars.indexOf(str.charAt(i++));
                out += String.fromCharCode((e1 << 2) | (e2 >> 4));
                if (e3 !== 64) out += String.fromCharCode(((e2 & 15) << 4) | (e3 >> 2));
                if (e4 !== 64) out += String.fromCharCode(((e3 & 3) << 6) | e4);
            }
            return out;
        }

        function parseMoneyToken(raw) {
            raw = String(raw || '')
                .replace(/&minus;/gi, '-')
                .replace(/&#8722;/g, '-')
                .replace(/\u2212/g, '-')
                .replace(/\u2013|\u2014/g, '-');
            var isNegative = raw.indexOf('-') >= 0 || raw.indexOf('(') >= 0;
            var n = parseFloat(raw.replace(/[^0-9.]/g, ''));
            if (isNaN(n)) return 0;
            return isNegative ? -Math.abs(n) : n;
        }

        function extractAgingFromHtml(htmlText) {
            if (!htmlText) return null;
            var text = htmlText
                .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/\s+/g, ' ');

            var headerRe = /Current\s+1\s*-?\s*30\s*Days?\s+31\s*-?\s*60\s*Days?\s+61\s*-?\s*90\s*Days?\s+Over\s*90\s*Days?\s+Amount\s+Due/i;
            var headerMatch = headerRe.exec(text);
            if (headerMatch) {
                var afterHeader = text.substring(headerMatch.index + headerMatch[0].length);
                var valRe = /\(?\s*[-\u2212\u2013\u2014]?\s*\$?\s*[\d,]+\.\d{2}\s*\)?/g;
                var vals = [];
                var vm;
                while ((vm = valRe.exec(afterHeader)) !== null && vals.length < 6) {
                    vals.push(parseMoneyToken(vm[0]));
                }
                if (vals.length >= 6) {
                    return { current: vals[0], d30: vals[1], d60: vals[2], d90: vals[3], d90plus: vals[4], total: vals[5] };
                }
            }

            function findAfter(labelRegex) {
                var re = new RegExp(
                    labelRegex +
                    '[^\\d\\(\\-\\u2212\\u2013\\u2014$]*' +
                    '(\\(?\\s*[-\\u2212\\u2013\\u2014]?\\s*\\$?\\s*[\\d,]+\\.\\d{2}\\s*\\)?)',
                    'i'
                );
                var m = re.exec(text);
                if (!m) return null;
                return parseMoneyToken(m[1]);
            }

            var aging = {
                current: findAfter('Current'),
                d30:     findAfter('1\\s*-?\\s*30\\s*Days?'),
                d60:     findAfter('31\\s*-?\\s*60\\s*Days?'),
                d90:     findAfter('61\\s*-?\\s*90\\s*Days?'),
                d90plus: findAfter('Over\\s*90\\s*Days?'),
                total:   findAfter('Amount\\s+Due')
            };
            log.audit('aging', aging)
            var any = aging.current != null || aging.d30 != null || aging.d60 != null || aging.d90 != null || aging.d90plus != null;
            return any ? aging : null;
        }

        function z2(n) {
            return (n < 10 ? '0' : '') + n;
        }

        function mmddyyyy(d) {
            d = d || new Date();
            var mm = (d.getMonth() + 1);
            var dd = (d.getDate());
            var yyyy = d.getFullYear();
            return mm + '/' + dd + '/' + yyyy;
        }

        return {
            buildXML: buildXML
        };
    });