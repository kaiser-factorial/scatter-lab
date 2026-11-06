# Independent references. Run in the pinned offline weighted R image.
suppressPackageStartupMessages({library(lavaan); library(psych); library(GPArotation); library(jsonlite)})
args <- commandArgs(TRUE)
out <- args[1]; source.dir <- args[2]
dir.create(out,recursive=TRUE,showWarnings=FALSE)
options(warn=1)
write <- function(value,file) write_json(value,file.path(out,file),auto_unbox=TRUE,digits=17,na="null",null="null",pretty=TRUE)
hash <- function(file) strsplit(system2("sha256sum",shQuote(file),stdout=TRUE)," ")[[1]][1]
versions <- as.list(sapply(c("lavaan","psych","GPArotation","jsonlite","polycor","numDeriv"),function(p)as.character(packageVersion(p))))
write(list(R=R.version.string,packages=versions,platform=R.version$platform,image=Sys.getenv("REFERENCE_IMAGE_ID",unset="unrecorded"),sourceSha256=hash(file.path(source.dir,"generate.R"))),"runtime.json")

# Source adapter only: redirect the one namespace-qualified call to the exact
# unchanged helper from the pinned FactoMineR source, no algorithm substitutions.
source(file.path(source.dir,"vendor/FactoMineR-svd.triplet.R"))
ipca <- paste(readLines(file.path(source.dir,"vendor/missMDA-imputePCA.R")),collapse="\n")
stopifnot(length(gregexpr("FactoMineR::svd.triplet",ipca,fixed=TRUE)[[1]])==1)
eval(parse(text=sub("FactoMineR::svd.triplet","svd.triplet",ipca,fixed=TRUE)))

rotations <- function(A,strict=FALSE) {
  result <- list()
  for(method in c("promax","oblimin","varimax")) {
    if(method=="oblimin") {
      fit<-GPArotation::oblimin(A,gam=0,normalize=FALSE,eps=1e-7,maxit=10000)
      L<-unclass(fit$loadings); phi<-fit$Phi
    } else {
      fit<-stats::varimax(A,normalize=TRUE,eps=if(strict)1e-14 else if(method=="promax")1e-5 else 1e-9)
      L<-unclass(fit$loadings); phi<-diag(ncol(A))
      if(method=="promax") {
        # The stats::promax power-four transformation and its canonical
        # varimax epsilon, matching the workbench non-weighted path.
        target<-L*abs(L)^3
        U<-solve(crossprod(L),crossprod(L,target))
        U<-sweep(U,2,sqrt(diag(solve(crossprod(U)))),"*")
        L<-L%*%U; transform<-fit$rotmat%*%U
        phi<-solve(transform)%*%t(solve(transform))
      }
    }
    result[[method]]<-list(pattern=unname(L),phi=unname(phi),structure=unname(L%*%phi),common=unname(L%*%phi%*%t(L)),converged=if(method=="oblimin")fit$convergence else TRUE,settings=list(kaiser=method!="oblimin",epsilon=if(method=="oblimin")1e-7 else if(strict)1e-14 else if(method=="promax")1e-5 else 1e-9,promaxPower=if(method=="promax")4 else NULL))
  }
  result
}
conditional <- function(x,mu,Sigma) {
  entries<-list()
  for(i in seq_len(nrow(x))) {
    m<-which(is.na(x[i,]));o<-which(!is.na(x[i,]))
    if(!length(m)||!length(o)) next
    estimate<-mu[m]+Sigma[m,o,drop=FALSE]%*%solve(Sigma[o,o,drop=FALSE],x[i,o]-mu[o])
    for(j in seq_along(m)) entries[[length(entries)+1]]<-list(row=i-1L,column=m[j]-1L,value=as.numeric(estimate[j]))
  }
  entries
}
fill <- function(x,method,ordinal=FALSE) {
  values<-numeric(ncol(x))
  for(j in seq_len(ncol(x))) {
    y<-sort(x[!is.na(x[,j]),j]); categories<-sort(unique(y))
    value<-if(method=="mean")mean(y) else if(ordinal)y[ceiling(length(y)/2)] else median(y)
    if(ordinal&&method=="mean")value<-categories[which.min(abs(categories-value))]
    x[is.na(x[,j]),j]<-value;values[j]<-value
  }
  list(data=x,values=values)
}
capture <- function(fn) {
  warnings<-character();start<-proc.time()[3]
  result<-tryCatch(withCallingHandlers(fn(),warning=function(w){warnings<<-c(warnings,conditionMessage(w));invokeRestart("muffleWarning")}),error=function(e)list(status="error",error=conditionMessage(e)))
  result$warnings<-as.list(warnings);result$seconds<-as.numeric(proc.time()[3]-start);result
}
ml.reference <- function(x,k,policy,ordinal) {
  source<-x;fills<-NULL
  if(policy=="complete")x<-x[complete.cases(x),,drop=FALSE]
  if(policy%in%c("mean","median")){filled<-fill(x,policy,ordinal);x<-filled$data;fills<-filled$values}
  if(policy=="fiml")x<-x[rowSums(!is.na(x))>0,,drop=FALSE]
  fit<-lavaan::efa(data=as.data.frame(x),nfactors=k,estimator="ML",missing=if(policy=="fiml")"ml" else "listwise",meanstructure=TRUE,rotation="none",bounds="pos.var",std.lv=TRUE,output="lavaan",se="none",test="standard",control=list(iter.max=10000,rel.tol=1e-10))
  est<-lavInspect(fit,"est");model<-fitted(fit);Sigma<-model$cov;mu<-as.numeric(model$mean)
  common<-Sigma-est$theta; E<-eigen(common,symmetric=TRUE)
  A<-sweep(E$vectors[,seq_len(k),drop=FALSE],2,sqrt(pmax(E$values[seq_len(k)],0)),"*")
  standardized<-sweep(A,1,sqrt(diag(Sigma)),"/")
  ll<-as.numeric(logLik(fit));optim<-lavInspect(fit,"optim")
  list(status="ok",converged=lavInspect(fit,"converged"),iterations=optim$iterations,nRows=nrow(x),logLikelihood=ll,negativeLogLikelihoodPerRow=-ll/nrow(x),means=mu,covariance=unname(Sigma),residualVariances=unname(diag(est$theta)),aic=as.numeric(AIC(fit)),bic=as.numeric(BIC(fit)),parameterCount=as.numeric(attr(logLik(fit),"df")),unrotatedStandardized=unname(standardized),rotations=rotations(standardized,TRUE),conditional=conditional(source,mu,Sigma),fills=fills,options=list(estimator="ML",missing=if(policy=="fiml")"ml" else "listwise",meanstructure=TRUE,bounds="pos.var",std.lv=TRUE,covarianceDenominator="N",rotation="none then independent stats/GPArotation with varimax epsilon1e-14 for ML"))
}
minres.reference <- function(x,k,policy,ordinal) {
  fills<-NULL
  if(policy=="complete")x<-x[complete.cases(x),,drop=FALSE]
  if(policy%in%c("mean","median")){filled<-fill(x,policy,ordinal);x<-filled$data;fills<-filled$values}
  R<-cor(x,use=if(policy=="pairwise")"pairwise.complete.obs" else "everything")
  fit<-psych::fa(R,nfactors=k,fm="minres",rotate="none",SMC=TRUE,smooth=FALSE)
  A<-unclass(fit$loadings);common<-tcrossprod(A)
  list(status="ok",correlation=unname(R),common=unname(common),objective=sum((R-common)[lower.tri(R)]^2),rotations=rotations(A),fills=fills,nRows=nrow(x),options=list(package="psych",fm="minres",SMC=TRUE,smooth=FALSE))
}
pca.reference <- function(x,k,policy,ordinal,standardize=TRUE) {
  source<-x;rows<-seq_len(nrow(x));fills<-NULL;imputed<-NULL
  if(policy=="complete"){rows<-which(complete.cases(x));x<-x[rows,,drop=FALSE]}
  if(policy%in%c("mean","median")){filled<-fill(x,policy,ordinal);x<-filled$data;fills<-filled$values}
  if(policy=="iterative") {
    result<-imputePCA(x,ncp=k,scale=standardize,method="Regularized",threshold=1e-8,maxiter=200,nb.init=1)
    x<-if(is.matrix(result))result else result$completeObs
    positions<-which(is.na(source),arr.ind=TRUE)
    imputed<-lapply(seq_len(nrow(positions)),function(q)list(row=positions[q,1]-1L,column=positions[q,2]-1L,value=x[positions[q,1],positions[q,2]]))
  }
  if(policy=="pairwise") {
    R<-if(standardize)cor(x,use="pairwise.complete.obs") else {
      pairN<-crossprod(!is.na(x));cov(x,use="pairwise.complete.obs")*(pairN-1)/pairN
    }
    E<-eigen(R,symmetric=TRUE);values<-E$values;vectors<-E$vectors
    if(min(values) < -1e-8)stop("Pairwise covariance/correlation is not positive semidefinite")
    mu<-colMeans(x,na.rm=TRUE);sd<-sqrt(colMeans(sweep(x,2,mu,"-")^2,na.rm=TRUE))
    rows<-which(complete.cases(x));z<-sweep(x[rows,,drop=FALSE],2,mu,"-")
    if(standardize)z<-sweep(z,2,sd,"/")
    scores<-z%*%vectors[,seq_len(k),drop=FALSE]
  } else {
    # prcomp uses sample SD and N-1 eigenvalue normalization. Convert only the
    # known scale conventions to the workbench population-standardized scores.
    fit<-prcomp(x,center=TRUE,scale.=standardize)
    values<-fit$sdev^2;if(!standardize)values<-values*(nrow(x)-1)/nrow(x)
    vectors<-fit$rotation;scores<-fit$x[,seq_len(k),drop=FALSE]
    if(standardize)scores<-scores*sqrt(nrow(x)/(nrow(x)-1))
  }
  sample<-unique(round(seq(1,nrow(scores),length.out=min(40,nrow(scores)))))
  list(status="ok",eigenvalues=unname(values),vectors=unname(vectors[,seq_len(k),drop=FALSE]),scoreRows=rows[sample]-1L,scores=unname(scores[sample,,drop=FALSE]),fills=fills,imputed=imputed,nRows=length(rows),options=list(package=if(policy=="iterative")"missMDA1.20/FactoMineR2.12 source adapter then stats::prcomp" else if(policy=="pairwise")"stats::cov/cor/eigen" else "stats::prcomp",standardize=standardize,populationScaleAdjustment=TRUE))
}
synthetic <- function(seed,family,n=600L,p=8L) {
  set.seed(seed);draw<-switch(family,normal=function(n)rnorm(n),heavy=function(n)rt(n,5)/sqrt(5/3),skew=function(n)(rlnorm(n,0,.6)-exp(.18))/sqrt((exp(.36)-1)*exp(.36)))
  F<-cbind(draw(n),draw(n));F[,2]<-.35*F[,1]+sqrt(1-.35^2)*F[,2]
  L<-matrix(.08,p,2);L[cbind(seq_len(p),rep(1:2,length.out=p))]<-.7;L[3,2]<-.25
  phi<-matrix(c(1,.35,.35,1),2)
  x<-F%*%t(L)+sweep(matrix(draw(n*p),n,p),2,sqrt(1-diag(L%*%phi%*%t(L))),"*")
  # Nonunit means/scales exercise the raw-data back transformation.
  x<-sweep(sweep(x,2,seq(.7,1.6,length.out=p),"*"),2,seq(-2,3,length.out=p),"+")
  colnames(x)<-paste0("Q",seq_len(p));x
}
missing <- function(x,seed,kind) {
  set.seed(seed)
  if(kind=="mcar")x[matrix(runif(length(x))<.12,nrow(x),ncol(x))]<-NA
  if(kind=="mar")for(j in 2:ncol(x))x[runif(nrow(x))<(.05+.2*plogis(as.numeric(scale(x[,1])))),j]<-NA
  x
}
cases<-list()
add<-function(name,x,k,origin,ordinal=FALSE){cases[[name]]<<-list(x=x,k=k,origin=origin,ordinal=ordinal)}
normal<-synthetic(60201,"normal");heavy<-synthetic(60202,"heavy");skew<-synthetic(60203,"skew")
add("normal-complete",normal,2,"Synthetic Gaussian factor model;seed60201")
add("normal-mcar",missing(normal,60211,"mcar"),2,"Synthetic Gaussian;12% MCAR seed60211")
add("normal-mar",missing(normal,60212,"mar"),2,"Synthetic Gaussian;missingness depends on fully observed Q1;seed60212")
add("heavy-mcar",missing(heavy,60213,"mcar"),2,"Synthetic t5 factors/residuals;MCAR")
add("skew-mar",missing(skew,60214,"mar"),2,"Synthetic standardized lognormal factors/residuals;MAR")
hs<-as.matrix(lavaan::HolzingerSwineford1939[paste0("x",1:9)])
add("holzinger-complete",hs,3,"lavaan::HolzingerSwineford1939, all301respondents,x1:x9")
add("holzinger-mcar",missing(hs,60215,"mcar"),3,"HolzingerSwineford1939 plus synthetic12%MCAR seed60215")
add("holzinger-mar",missing(hs,60216,"mar"),3,"HolzingerSwineford1939 plus missingness depending on x1;seed60216")
data(bfi,package="psych");bf<-as.matrix(bfi[,1:25]);keys<-c("A1","C4","C5","E1","E2","O2","O5");bf[,keys]<-7-bf[,keys]
add("bfi25-original",bf,5,"R personality dataset interpreted as psych::bfi;all2800respondents,25items;7-x reversal A1,C4,C5,E1,E2,O2,O5;originalmissingness",TRUE)
ordinal<-apply(scale(normal),2,function(v)as.integer(cut(v,c(-Inf,-1,-.3,.3,1,Inf),labels=FALSE)));colnames(ordinal)<-colnames(normal)
add("ordinal-mcar",missing(ordinal,60217,"mcar"),2,"Normal synthetic converted to5categories;MCAR seed60217",TRUE)

ledger<-list()
for(name in names(cases)) {
  case<-cases[[name]];x<-case$x;k<-case$k
  input<-list(columns=colnames(x),data=as.list(as.data.frame(x)),nRows=nrow(x),nFactors=k,ordinal=case$ordinal,origin=case$origin)
  write(input,paste0(name,".input.json"))
  result<-list(provenance=list(inputSha256=hash(file.path(out,paste0(name,".input.json"))),R=R.version.string,packages=versions),ml=list(),minres=list(),pca=list())
  for(policy in c("complete","mean","median","fiml")) {
    cat(name,"ML",policy,"\n");flush.console()
    result$ml[[policy]]<-capture(function()ml.reference(x,k,policy,case$ordinal))
  }
  for(policy in c("complete","mean","median","pairwise")) {
    cat(name,"MINRES",policy,"\n");flush.console()
    result$minres[[policy]]<-capture(function()minres.reference(x,k,policy,case$ordinal))
  }
  for(policy in c("complete","mean","median","pairwise","iterative"))for(standardize in c(TRUE,FALSE)) {
    key<-paste(policy,if(standardize)"scaled" else "raw",sep="-")
    cat(name,"PCA",key,"\n");flush.console()
    result$pca[[key]]<-capture(function()pca.reference(x,k,policy,case$ordinal,standardize))
  }
  write(result,paste0(name,".reference.json"))
  ledger[[name]]<-lapply(result[c("ml","minres","pca")],function(group)lapply(group,function(v)list(status=v$status,error=v$error,seconds=v$seconds)))
  write(ledger,"progress.json")
}
write(list(status="complete",datasets=names(cases),modelsPerDataset=list(ml=4,minres=4,pca=10),largestSynthetic="Not executed; reserved until accuracy qualification."),"generation.json")
