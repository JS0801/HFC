/**
 *@NApiVersion 2.x
*@NScriptType Suitelet
*/


define(['N/ui/serverWidget', 'N/runtime','N/redirect', 'N/search', 'N/record','N/file','N/format','N/ui/message','N/task'],
	function(serverWidget, runtime, redirect, search, record, file, format,message,task) {
		

	function onRequest(context) {
	
		var REQUEST_METHOD 	 = context.request.method;
		
		if(REQUEST_METHOD === 'GET'){
			try{
			var DEBUG_IDENTIFIER = 'GET';
			var request 		= context.request;
			var status 			= request.parameters.custscript_status || '';
			var form = serverWidget.createForm({
				title: 'Upload File'
			});
				
			
			
			form.addSubmitButton({id:'submit', label:'Run File'});
				
			var attachment = form.addField({
				id 	  	 : 'custpage_attachment',
				label 	 : 'Attachment',
				type  	 : serverWidget.FieldType.FILE
			});							
				
			attachment.isMandatory 	= true;

			if(status == 'pending')
			{
								
				var messageObj = message.create({ title: "Processing",  type: message.Type.INFORMATION, message: 'Payments are being reversed..'});
				form.addPageInitMessage({
				message: messageObj
				});
			}	

			context.response.writePage(form);
			
			}
			catch(e){	
				log.audit({
					title: e.name,
					details: e.message
				});		
			}
			log.debug(DEBUG_IDENTIFIER, '--END--');
		}
		else{
			
			var DEBUG_IDENTIFIER = 'POST';
			
			var file_attach = context.request.files.custpage_attachment;	
			if(!isNullOrEmpty(file_attach)){
				file_attach.folder 	= 329224;
				var file_id 		= file_attach.save();
				log.debug(DEBUG_IDENTIFIER, 'FILE SAVED');
					

			var mrTask = task.create({
			taskType: task.TaskType.MAP_REDUCE,
			scriptId: 2744,
			params: {
				'custscript_fileid': file_id
				
			}
			});
		}
		
			
			mrTask.submit(); // RETURNS TASK ID - RETURN AS PARAMETER
			
			redirect.toSuitelet({
				scriptId: 'customscript_uploadfile',
				deploymentId: 'customdeploy_uploadfile',
				parameters: {
				   'custscript_status':'pending'
			   }

			});
		}
	}
				

	
			





				
	function isNullOrEmpty(objVariable){
		return (objVariable == null || objVariable == "" || objVariable == undefined || objVariable == 'undefined' || objVariable == 0);
	};

	return {
		onRequest: onRequest
	};
});