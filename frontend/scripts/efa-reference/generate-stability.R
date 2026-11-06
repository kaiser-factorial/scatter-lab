library(polycor);library(psych);library(GPArotation);library(jsonlite)
out<-if(length(commandArgs(TRUE)))commandArgs(TRUE)[1] else "/out"
dir.create(out,recursive=TRUE,showWarnings=FALSE)
set.seed(50911)
fit<-function(x){
  p<-ncol(x);r<-diag(p)
  for(i in seq_len(p-1))for(j in (i+1):p){ok<-complete.cases(x[,c(i,j)]);r[i,j]<-r[j,i]<-polychor(x[ok,i],x[ok,j],ML=FALSE,maxcor=.9999)}
  a<-unclass(fa(r,nfactors=2,fm="minres",rotate="none",SMC=TRUE,smooth=FALSE)$loadings)
  rotation<-oblimin(a,gam=0,normalize=FALSE,eps=1e-7,maxit=10000);stopifnot(rotation$convergence)
  pattern<-unclass(rotation$loadings);phi<-rotation$Phi;structure<-pattern%*%phi;model<-structure%*%t(pattern)
  list(pattern=pattern,phi=phi,structure=structure,communalities=diag(model),uniquenesses=1-diag(model),rmsr=sqrt(mean((r-model)[lower.tri(r)]^2)))
}
align<-function(a,b){
  congruence<-crossprod(a$pattern,b$pattern)/sqrt(outer(colSums(a$pattern^2),colSums(b$pattern^2)))
  order<-if(sum(abs(diag(congruence)))>=sum(abs(congruence[cbind(1:2,2:1)])))1:2 else 2:1
  signs<-ifelse(congruence[cbind(1:2,order)]<0,-1,1)
  b$pattern<-sweep(b$pattern[,order,drop=FALSE],2,signs,"*");b$structure<-sweep(b$structure[,order,drop=FALSE],2,signs,"*")
  b$phi<-b$phi[order,order]*outer(signs,signs);b$congruence<-abs(congruence[cbind(1:2,order)]);b
}
cases<-list()
for(distribution in c("normal","heavy-tail","skew")){
  n<-650L;p<-8L
  draw<-switch(distribution,normal=function(n)rnorm(n),"heavy-tail"=function(n)rt(n,5)/sqrt(5/3),skew=function(n)(rlnorm(n,0,.6)-exp(.18))/sqrt((exp(.36)-1)*exp(.36)))
  f1<-draw(n);f2<-.4*f1+sqrt(1-.4^2)*draw(n)
  x<-sapply(seq_len(p),function(j){z<-.65*if(j%%2)f1 else f2;z<-z+.76*draw(n);as.integer(cut(z,c(-Inf,if(j%%3==0)c(-.5,.7) else c(-1,-.2,.4,1.2),Inf),labels=FALSE))})
  x[matrix(runif(n*p)<.07,n,p)]<-NA;colnames(x)<-paste0("item",seq_len(p))
  baseline<-fit(x);samples<-lapply(seq_len(6),function(i)sample.int(n,n,replace=TRUE))
  replicas<-lapply(samples,function(indices)align(baseline,fit(x[indices,,drop=FALSE])))
  cases[[distribution]]<-list(table=list(columns=colnames(x),data=as.list(as.data.frame(x)),nRows=n,categories=lapply(seq_len(p),function(j)seq_len(if(j%%3==0)3 else 5))),baseline=baseline,samples=lapply(samples,function(indices)indices-1L),replicas=replicas)
}
write_json(list(provenance=list(R=R.version.string,psych=as.character(packageVersion("psych")),polycor=as.character(packageVersion("polycor")),GPArotation=as.character(packageVersion("GPArotation")),seed=50911,alignment="Sign and permutation only; explicit saved respondent bootstrap samples; no psych target rotation"),cases=cases),file.path(out,"stability.reference.json"),auto_unbox=TRUE,na="null",digits=17,pretty=TRUE)

spectrum<-function(x){
  p<-ncol(x);r<-diag(p)
  for(i in seq_len(p-1))for(j in (i+1):p){ok<-complete.cases(x[,c(i,j)]);r[i,j]<-r[j,i]<-polychor(x[ok,i],x[ok,j],ML=FALSE,maxcor=.9999)}
  stopifnot(min(eigen(r,symmetric=TRUE,only.values=TRUE)$values)>1e-8)
  one<-fa(r,nfactors=1,fm="minres",rotate="none",SMC=TRUE,smooth=FALSE)
  psychModel<-unclass(one$loadings)%*%t(unclass(one$loadings));psychReduced<-r;diag(psychReduced)<-diag(psychModel)
  # Preserve psych's output. Its MINRES gradient is a diagonal residual rather
  # than the derivative of its lower-triangle objective. On weak nulls its
  # default stopping rule can also leave visible communality differences.
  # Independently qualify the stated bounded objective with R's numerical
  # derivatives, starting from exactly the same SMC uniquenesses. This is NOT
  # a claim of parity with psych's default optimization path on every null.
  model<-function(psi){reduced<-r;diag(reduced)<-1-psi;e<-eigen(reduced,symmetric=TRUE);loading<-e$vectors[,1,drop=FALSE]*sqrt(e$values[1]);loading%*%t(loading)}
  objective<-function(psi)sum((r-model(psi))[lower.tri(r)]^2)
  optimized<-optim(1/diag(solve(r)),objective,method="L-BFGS-B",lower=.005,upper=1,control=list(factr=1,pgtol=1e-10,maxit=2000,ndeps=rep(1e-6,p)))
  stopifnot(optimized$convergence==0)
  reduced<-r;diag(reduced)<-diag(model(optimized$par))
  list(eigenvalues=eigen(reduced,symmetric=TRUE,only.values=TRUE)$values,objective=optimized$value,uniquenessParameters=optimized$par,psychEigenvalues=eigen(psychReduced,symmetric=TRUE,only.values=TRUE)$values,psychObjective=sum((r-psychModel)[lower.tri(r)]^2))
}
for(name in names(cases)){
  set.seed(73411);input<-cases[[name]]$table;x<-as.matrix(as.data.frame(input$data))
  observed<-spectrum(x);null<-list();failures<-list()
  for(i in 1:100){
    permuted<-x
    for(j in seq_len(ncol(x))){valid<-which(!is.na(x[,j]));permuted[valid,j]<-sample(x[valid,j])}
    values<-tryCatch(spectrum(permuted),error=function(error){failures[[length(failures)+1]]<<-list(replicate=i-1L,error=conditionMessage(error));NULL})
    null[[i]]<-c(list(data=as.list(as.data.frame(permuted))),if(is.null(values))list(eigenvalues=NULL) else values)
  }
  good<-Filter(function(v)!is.null(v$eigenvalues),null)
  reference<-apply(do.call(rbind,lapply(good,function(v)v$eigenvalues)),2,quantile,probs=.95,type=7)
  write_json(list(provenance=list(R=R.version.string,psych=as.character(packageVersion("psych")),polycor=as.character(packageVersion("polycor")),seed=73411,convention="100 fixed-mask permutations; one-factor bounded lower-triangle MINRES independently optimized by R optim numerical derivatives; saved actual null datasets; 95th percentile type 7",optimizer=list(method="L-BFGS-B",lower=.005,upper=1,factr=1,pgtol=1e-10,maxit=2000,ndeps=1e-6,start="1/diag(solve(R))"),qualification="Native exact analytic objective parity is checked against independent numerical-derivative R optimization. psych default outputs remain available for comparison; weak nulls need not take the same optimization path."),input=input,observed=observed$eigenvalues,observedFit=observed,null=null,failures=failures,reference=reference),file.path(out,paste0("parallel-",name,".reference.json")),auto_unbox=TRUE,na="null",null="null",digits=17,pretty=FALSE)
}
