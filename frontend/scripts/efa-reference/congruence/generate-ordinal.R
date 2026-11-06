suppressPackageStartupMessages({library(lavaan);library(polycor);library(psych);library(GPArotation);library(jsonlite)})
args<-commandArgs(TRUE);out<-args[1];source.dir<-args[2]
hash<-function(file)strsplit(system2("sha256sum",shQuote(file),stdout=TRUE)," ")[[1]][1]
write<-function(x,file)write_json(x,file.path(out,file),auto_unbox=TRUE,digits=17,na="null",null="null",pretty=TRUE)
# Reuse the independently implemented pair-margin influence calculation from
# the already pinned weighted R reference, not the production TypeScript.
expressions<-parse(file.path(source.dir,"pair-moments-source.R"))
selected<-Filter(function(e)is.call(e)&&identical(e[[1]],as.name("<-"))&&identical(e[[2]],as.name("pair_moments")),as.list(expressions))
stopifnot(length(selected)==1);eval(selected[[1]])
rotate.reference<-function(A,strict=FALSE){
  results<-list()
  for(method in c("promax","oblimin","varimax")){
    if(method=="oblimin"){
      f<-GPArotation::oblimin(A,gam=0,normalize=FALSE,eps=1e-7,maxit=10000);L<-unclass(f$loadings);phi<-f$Phi;converged<-f$convergence
    }else{
      f<-stats::varimax(A,normalize=TRUE,eps=if(strict)1e-14 else if(method=="promax")1e-5 else 1e-9);L<-unclass(f$loadings);phi<-diag(ncol(A));converged<-TRUE
      if(method=="promax"){
        target<-L*abs(L)^3;U<-solve(crossprod(L),crossprod(L,target));U<-sweep(U,2,sqrt(diag(solve(crossprod(U)))),"*")
        L<-L%*%U;T<-f$rotmat%*%U;phi<-solve(T)%*%t(solve(T))
      }
    }
    results[[method]]<-list(pattern=unname(L),phi=unname(phi),common=unname(L%*%phi%*%t(L)),converged=converged)
  };results
}
capture<-function(fn){
  warnings<-character();start<-proc.time()[3]
  result<-tryCatch(withCallingHandlers(fn(),warning=function(w){warnings<<-c(warnings,conditionMessage(w));invokeRestart("muffleWarning")}),error=function(e)list(status="error",error=conditionMessage(e)))
  result$warnings<-as.list(warnings);result$seconds<-as.numeric(proc.time()[3]-start);result
}
for(name in c("ordinal-mcar","bfi25-original")){
  input<-fromJSON(file.path(out,paste0(name,".input.json")));
  source<-as.matrix(as.data.frame(input$data));storage.mode(source)<-"double";k<-input$nFactors
  results<-list(provenance=list(inputSha256=hash(file.path(out,paste0(name,".input.json"))),R=R.version.string,lavaan=as.character(packageVersion("lavaan")),polycor=as.character(packageVersion("polycor")),generatorSha256=hash(file.path(source.dir,"generate-ordinal.R")),pairMomentsSourceSha256=hash(file.path(source.dir,"pair-moments-source.R")),scope="Independent R pair-margin polychoric/influence moments supplied to lavaan DWLS plus scaled.shifted WLSMV correction. This intentionally differs from raw-data lavaan defaults with shared thresholds or zero-cell corrections."),policies=list())
  for(policy in c("pairwise","complete","mean","median")){
    cat(name,"ordinal",policy,"\n");flush.console()
    results$policies[[policy]]<-capture(function(){
      x<-source
      if(policy=="complete")x<-x[complete.cases(x),,drop=FALSE]
      if(policy%in%c("mean","median"))for(j in seq_len(ncol(x))){
        y<-sort(x[!is.na(x[,j]),j]);categories<-sort(unique(y));v<-if(policy=="median")y[ceiling(length(y)/2)] else categories[which.min(abs(categories-mean(y)))];x[is.na(x[,j]),j]<-v
      }
      moments<-pair_moments(x);R<-moments$correlation;dimnames(R)<-list(colnames(x),colnames(x));gamma<-moments$gamma
      minres<-psych::fa(R,nfactors=k,fm="minres",rotate="none",SMC=TRUE,smooth=FALSE);A<-unclass(minres$loadings)
      fit<-lavaan::efa(sample.cov=R,sample.nobs=nrow(x),nfactors=k,correlation=TRUE,estimator="DWLS",WLS.V=diag(1/diag(gamma)),NACOV=gamma,se="robust.sem",test="scaled.shifted",rotation="none",bounds="none",std.lv=TRUE,sample.cov.rescale=FALSE,output="lavaan",control=list(iter.max=10000))
      est<-lavInspect(fit,"est");common<-est$lambda%*%est$psi%*%t(est$lambda);E<-eigen(common,symmetric=TRUE);B<-sweep(E$vectors[,seq_len(k),drop=FALSE],2,sqrt(E$values[seq_len(k)]),"*")
      list(status="ok",nRows=nrow(x),originalCounts=unname(crossprod(!is.na(if(policy=="complete")source[complete.cases(source),,drop=FALSE] else source))),correlation=unname(R),gamma=unname(gamma),minres=list(common=unname(tcrossprod(A)),objective=sum((R-tcrossprod(A))[lower.tri(R)]^2),rotations=rotate.reference(A)),weighted=list(converged=lavInspect(fit,"converged"),common=unname(common),rotations=rotate.reference(B,TRUE),test=lavInspect(fit,"test")))
    })
    write(results,paste0(name,".ordinal-reference.json"))
  }
}
