args<-commandArgs(TRUE);folder<-args[1]
op<-jsonlite::read_json(file.path(folder,"operation.json"),simplifyVector=FALSE)
num<-function(x)if(is.null(x))NA_real_ else as.numeric(x)
mat<-function(x)do.call(rbind,lapply(x,function(row)vapply(row,num,numeric(1))))
input<-mat(op$input);expected<-mat(op$completed)
csv<-read.csv(file.path(folder,"r-completed.csv"),check.names=FALSE)
output<-as.matrix(csv[,-1,drop=FALSE]);mask<-!is.na(input)
maxdiff<-function(a,b){d<-abs(a-b);if(all(is.na(d)))0 else max(d,na.rm=TRUE)}
result<-list(status="passed",R=R.version.string,jsonlite=as.character(packageVersion("jsonlite")),rows=nrow(output),columns=ncol(output),sourceRowsExact=identical(as.numeric(csv$source_row),as.numeric(unlist(op$rows)+1)),missingMaskExact=identical(unname(is.na(output)),unname(is.na(expected))),maximumPredictionDifference=maxdiff(output[!mask],expected[!mask]),observedValuesMaximumSerializationDifference=maxdiff(output[mask],input[mask]),qualification="R computes the same saved-model conditional means. CSV serialization may round numeric text; native operation preserves observed cells exactly. This is replay parity, not a second lavaan fit.")
if(!result$sourceRowsExact||!result$missingMaskExact||result$maximumPredictionDifference>1e-10||result$observedValuesMaximumSerializationDifference>1e-12)result$status<-"failed"
jsonlite::write_json(result,file.path(folder,"r-report.json"),auto_unbox=TRUE,digits=17,pretty=TRUE)
stopifnot(result$status=="passed")
