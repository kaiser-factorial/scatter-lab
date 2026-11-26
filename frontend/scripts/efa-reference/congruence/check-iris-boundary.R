args<-commandArgs(TRUE);source.dir<-args[1];input<-args[2];native<-args[3];out<-args[4]
source(file.path(source.dir,"vendor/FactoMineR-svd.triplet.R"))
code<-paste(readLines(file.path(source.dir,"vendor/missMDA-imputePCA.R")),collapse="\n")
code<-sub("FactoMineR::svd.triplet","svd.triplet",code,fixed=TRUE)
eval(parse(text=code));canonical<-imputePCA
# Diagnostic-only counter, crosschecked against unchanged canonical output.
code<-sub("nb.iter <- nb.iter + 1","diagnostic.iterations <<- diagnostic.iterations + 1; nb.iter <- nb.iter + 1",code,fixed=TRUE)
eval(parse(text=code));instrumented<-imputePCA
inputs<-jsonlite::read_json(input,simplifyVector=FALSE)
ts<-jsonlite::read_json(native,simplifyVector=FALSE)
num<-function(x)if(is.null(x))NA_real_ else as.numeric(x)
columns<-function(x)do.call(cbind,lapply(x,function(col)vapply(col,num,numeric(1))))
rows<-function(x)do.call(rbind,lapply(x,function(row)vapply(row,num,numeric(1))))
results<-list()
for(i in seq_along(inputs))for(budget in c(200,1000)) {
  item<-inputs[[i]];x<-columns(item$columns);warnings<-character();diagnostic.iterations<-0L
  actual<-withCallingHandlers(canonical(x,ncp=item$rank,scale=item$standardize,threshold=item$tol,maxiter=budget),warning=function(w){warnings<<-c(warnings,conditionMessage(w));invokeRestart("muffleWarning")})
  diagnostic<-suppressWarnings(instrumented(x,ncp=item$rank,scale=item$standardize,threshold=item$tol,maxiter=budget))
  saved<-ts[[i]]$completions[[which(vapply(ts[[i]]$results,function(c)c$maxIter,numeric(1))==budget)]]
  expected<-columns(saved)
  results[[length(results)+1]]<-list(seed=item$seed,rate=item$rate,maxIter=budget,threshold=item$tol,iterations=diagnostic.iterations,converged=length(warnings)==0L,warnings=as.list(warnings),maximumCompletionDifference=max(abs(actual$completeObs-expected)),instrumentationOutputDifference=max(abs(actual$completeObs-diagnostic$completeObs)))
}
jsonlite::write_json(list(R=R.version.string,qualification="Unchanged pinned missMDA1.20/FactoMineR2.12 source adapter. A separate counter-only instrumented copy records iteration counts and must return exactly identical completed matrices.",results=results),out,pretty=TRUE,auto_unbox=TRUE,digits=17)
