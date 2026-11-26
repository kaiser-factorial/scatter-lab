library(MASS)
library(jsonlite)
stopifnot(as.character(packageVersion("MASS")) == "7.3.65")
out <- if(length(commandArgs(TRUE)))commandArgs(TRUE)[1] else "/out"
dir.create(out,recursive=TRUE,showWarnings=FALSE)
reference <- new.env(parent=globalenv())
sys.source("/opt/mice/R/mice.impute.logreg.R",envir=reference)
sys.source("/opt/mice/R/mice.impute.polr.R",envir=reference)
reference$sym <- function(x)(x+t(x))/2
set.seed(17203)
cases <- list()
for(name in c("ordinal","binary","heavy-tail-skew","single-missing","separation","ordinal-seven","ordinal-eleven")) {
  n <- 600L; k <- if(name=="binary")2L else if(name=="ordinal-seven")7L else if(name=="ordinal-eleven")11L else 5L
  x <- cbind(x1=rnorm(n),x2=rt(n,5)/sqrt(5/3),x3=(rlnorm(n,0,.4)-exp(.08))/sqrt((exp(.16)-1)*exp(.16)))
  latent <- .8*x[,1]-.6*x[,2]+.3*x[,3]+if(name=="heavy-tail-skew")rt(n,3)/sqrt(3) else rlogis(n)
  if(name=="separation")latent<-4*x[,1]
  cuts<-if(k==2)0 else if(k>5)qlogis(seq_len(k-1)/k) else c(-1.5,-.4,.5,1.8)
  full<-as.integer(cut(latent,c(-Inf,cuts,Inf),labels=FALSE))
  missing<-if(name=="single-missing")seq_len(n)==37 else runif(n)<plogis(-1.4+.5*x[,1])
  y<-ordered(replace(full,missing,NA),levels=seq_len(k))
  aug<-reference$augment(y,!missing,x,missing)
  u<-runif(sum(missing));z<-rnorm(ncol(x)+1)
  stableReference<-NULL
  reference$runif<-function(n,...) {stopifnot(n==length(u));u}
  reference$rnorm<-function(n,...) {stopifnot(n==length(z));z}
  if(k>2) {
    frame<-data.frame(y=aug$y,aug$x)
    model<-MASS::polr(y~.,frame[aug$ry,],weights=aug$w[aug$ry],control=list(reltol=1e-12,maxit=2000))
    stopifnot(model$convergence==0)
    probabilities<-predict(model,data.frame(x[missing,,drop=FALSE]),type="probs")
    if(sum(missing)==1)probabilities<-matrix(probabilities,nrow=1)
    imputed<-reference$mice.impute.polr(y,!missing,x,reltol=1e-12,maxit=2000)
    expected<-list(coefficients=unname(coef(model)),thresholds=unname(model$zeta),objective=deviance(model)/2,probabilities=unname(probabilities),draws=as.integer(imputed)-1L)
    if(name=="separation") {
      # Keep the original MASS outputs above. Probability subtraction loses
      # relative precision in this extreme fixture (some cells are ~1e-13).
      # Independently optimize the same likelihood in log space with R's
      # numerical-derivative BFGS, without using the native analytic gradient.
      xx<-as.matrix(aug$x)[aug$ry,,drop=FALSE]; yy<-as.integer(aug$y[aug$ry]); ww<-aug$w[aug$ry]; d<-ncol(xx)
      stableNll<-function(parameters) {
        thresholds<-c(-Inf,cumsum(c(parameters[d+1],exp(parameters[(d+2):length(parameters)]))),Inf)
        eta<-as.vector(xx%*%parameters[seq_len(d)]); lo<-thresholds[yy]-eta; hi<-thresholds[yy+1]-eta
        lp<-numeric(length(yy));first<-yy==1;last<-yy==k;middle<-!first&!last
        lp[first]<-plogis(hi[first],log.p=TRUE);lp[last]<-plogis(-lo[last],log.p=TRUE)
        delta<-hi[middle]-lo[middle]
        lp[middle]<-plogis(lo[middle],log.p=TRUE)+plogis(-hi[middle],log.p=TRUE)+ifelse(delta>50,delta,log(expm1(delta)))
        -sum(ww*lp)
      }
      start<-c(coef(model),model$zeta[1],log(diff(model$zeta)))
      stableFit<-optim(start,stableNll,method="BFGS",control=list(reltol=1e-13,maxit=2000,ndeps=rep(1e-5,length(start))))
      stopifnot(stableFit$convergence==0)
      beta<-stableFit$par[seq_len(d)]; thresholds<-cumsum(c(stableFit$par[d+1],exp(stableFit$par[(d+2):length(start)])))
      stableProb<-t(apply(x[missing,,drop=FALSE],1,function(row)diff(c(0,plogis(thresholds-sum(row*beta)),1))))
      stableReference<-list(coefficients=unname(beta),thresholds=unname(thresholds),objective=stableFit$value,probabilities=unname(stableProb),reason="Same proportional-odds likelihood evaluated in log space; original MASS output preserved separately")
    }
  } else {
    design<-cbind(1,as.matrix(aug$x))
    model<-glm.fit(design[aug$ry,,drop=FALSE],as.integer(aug$y[aug$ry])-1L,family=quasibinomial(),weights=aug$w[aug$ry],control=glm.control(epsilon=1e-12,maxit=200))
    covariance<-summary.glm(model)$cov.unscaled
    sampled<-coef(model)+t(chol(covariance))%*%z
    imputed<-reference$mice.impute.logreg(y,!missing,x)
    expected<-list(beta=unname(coef(model)),covariance=unname(covariance),sampled=as.vector(sampled),probabilities=as.vector(plogis(cbind(1,x[missing,,drop=FALSE])%*%sampled)),draws=as.integer(imputed)-1L)
  }
  cases[[name]]<-list(name=name,x=unname(x),y=as.integer(y)-1L,levels=k,uniforms=u,normals=z,augmented=sum(aug$ry)-sum(!missing),expected=expected,stableReference=stableReference)
}
write_json(list(provenance=list(R=R.version.string,MASS=as.character(packageVersion("MASS")),miceSource="3.18.0",archiveSha256="c0ce097a7f68edd2f4d6a3e6bfb133886e709513299dafdac79ec549c93edfa2",scope="Unmodified mice conditional functions and MASS fits; not the whole mice sampler",seed=17203),cases=cases),file.path(out,"conditional.reference.json"),auto_unbox=TRUE,digits=17,na="null",null="null",pretty=TRUE)

contrastLevels<-c(2L,3L,5L,7L,11L)
contrastCases<-setNames(lapply(contrastLevels,function(k)if(k==2)matrix(c(0,1),ncol=1) else unname(contr.poly(k))),as.character(contrastLevels))
write_json(list(provenance=list(R=R.version.string,stats=as.character(packageVersion("stats")),method="contr.poly for ordered factors; binary treatment contrast as used by mice model.matrix"),input=list(levels=contrastLevels,binaryTreatment=TRUE),cases=contrastCases),file.path(out,"ordinal-contrasts.reference.json"),auto_unbox=TRUE,digits=17,pretty=TRUE)

# A fixed FCS visit schedule invoking the actual pinned mice conditional
# functions. Save every stochastic input; do not assume identical R/JS RNGs.
for(family in c("heavy-tail","skew"))for(encoding in c("rank","ordered-polynomial")) {
chainSeed<-if(family=="heavy-tail")22031L else 22032L
set.seed(chainSeed)
n<-400L;p<-4L;levels<-c(2L,5L,3L,4L)
f<-if(family=="heavy-tail")rt(n,5)/sqrt(5/3) else (rlnorm(n,0,.8)-exp(.32))/sqrt((exp(.64)-1)*exp(.64))
full<-sapply(seq_len(p),function(j){
  error<-if(family=="heavy-tail")rlogis(n) else (rchisq(n,4)-4)/sqrt(8)
  as.integer(cut(.7*f+error,c(-Inf,qlogis(seq_len(levels[j]-1)/levels[j]),Inf),labels=FALSE))
})
raw<-full
for(j in seq_len(p))raw[runif(n)<plogis(-1.8+.25*f),j]<-NA
colnames(raw)<-paste0("item",seq_len(p))
saved<-list();completed<-list();traces<-list()
recordDraw<-function(m,iteration,j,kind,values){saved[[length(saved)+1]]<<-list(imputation=m-1L,iteration=iteration,item=j-1L,kind=kind,values=values)}
for(m in 1:2){
  current<-raw
  for(j in seq_len(p)){
    miss<-is.na(raw[,j]);donors<-raw[!miss,j];u<-runif(sum(miss));recordDraw(m,0L,j,"initial",u)
    current[miss,j]<-donors[1L+floor(u*length(donors))]
  }
  for(iteration in 1:3)for(j in seq_len(p)){
    miss<-is.na(raw[,j]);y<-factor(raw[,j],levels=seq_len(levels[j]),ordered=levels[j]>2)
    x<-current[,-j,drop=FALSE]
    if(encoding=="ordered-polynomial") {
      predictors<-as.data.frame(lapply(setdiff(seq_len(p),j),function(index)factor(current[,index],levels=seq_len(levels[index]),ordered=levels[index]>2)))
      names(predictors)<-paste0("predictor",seq_len(ncol(predictors)))
      x<-model.matrix(~.,predictors)[,-1,drop=FALSE]
    }
    if(levels[j]==2){z<-rnorm(ncol(x)+1);recordDraw(m,iteration,j,"normal",z)}
    u<-runif(sum(miss));recordDraw(m,iteration,j,"uniform",u)
    reference$runif<-function(n,...) {stopifnot(n==length(u));u}
    reference$rnorm<-function(n,...) {stopifnot(n==length(z));z}
    imputed<-if(levels[j]==2)reference$mice.impute.logreg(y,!miss,x) else reference$mice.impute.polr(y,!miss,x,reltol=1e-12,maxit=2000)
    current[miss,j]<-as.integer(imputed)
    traces[[length(traces)+1]]<-list(imputation=m-1L,iteration=iteration,item=j-1L,mean=mean(current[miss,j]),sd=sd(current[miss,j]))
  }
  completed[[m]]<-unname(current-1L)
}
fits<-lapply(completed,function(x){
  r<-diag(p)
  for(i in seq_len(p-1))for(j in (i+1):p)r[i,j]<-r[j,i]<-polycor::polychor(x[,i],x[,j],ML=FALSE,maxcor=.9999)
  one<-psych::fa(r,nfactors=1,fm="minres",rotate="none",SMC=TRUE,smooth=FALSE)
  pattern<-unclass(one$loadings);model<-pattern%*%t(pattern)
  list(correlation=r,pattern=pattern,communalities=diag(model),uniquenesses=1-diag(model),rmsr=sqrt(mean((r-model)[lower.tri(r)]^2)))
})
write_json(list(provenance=list(R=R.version.string,MASS=as.character(packageVersion("MASS")),miceSource="3.18.0",polycor=as.character(packageVersion("polycor")),psych=as.character(packageVersion("psych")),scope="Fixed explicit FCS driver calling unmodified mice conditional functions; all random inputs saved; independent EFA on each completed imputation",seed=chainSeed,distribution=family),table=list(columns=colnames(raw),data=as.list(as.data.frame(raw)),nRows=n,categories=lapply(levels,seq_len)),options=list(imputations=2L,iterations=3L,seed=chainSeed,predictorEncoding=encoding,predictors=lapply(seq_len(p),function(j)setdiff(seq_len(p),j)-1L)),draws=saved,completed=completed,fits=fits,trace=traces),file.path(out,paste0("mice-chain",if(encoding=="rank")"" else "-polynomial",if(family=="skew")"-skew" else "",".reference.json")),auto_unbox=TRUE,digits=17,na="null",null="null",pretty=TRUE)
}
