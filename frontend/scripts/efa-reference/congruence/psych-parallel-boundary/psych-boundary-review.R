library(psych);library(polycor);library(jsonlite)
env<-new.env(parent=asNamespace('psych'));env$SMC<-TRUE;env$control<-NULL
targets<-c('fit.residuals','fit','FAgr.minres','FAout.wls')
for(s in as.list(body(getFromNamespace('fac','psych')))[-1]) { if(!is.call(s)||!identical(s[[1]],as.name('<-'))) next; lhs<-s[[2]]; if((is.symbol(lhs)||is.character(lhs))&&length(lhs)==1&&as.character(lhs)%in%targets) eval(s,env) }
output<-list()
for(case in list(list(name='normal',index=67L),list(name='heavy-tail',index=94L))) {
 f<-read_json(paste0('/fixtures/parallel-',case$name,'.reference.json'),simplifyVector=FALSE)
 raw<-f$null[[case$index]];x<-sapply(raw$data,function(c)vapply(c,function(v)if(is.null(v))NA_real_ else as.numeric(v),numeric(1)))
 p<-ncol(x);r<-diag(p)
 for(i in seq_len(p-1))for(j in (i+1):p){ok<-complete.cases(x[,c(i,j)]);r[i,j]<-r[j,i]<-polychor(x[ok,i],x[ok,j],ML=FALSE,maxcor=.9999)}
 fit<-env$fit(r,1,'minres',FALSE)
 output[[case$name]]<-list(index0=case$index-1L,correlation=r,psychPsi=fit$res$par,psychObjective=fit$res$value,psychConvergence=fit$res$convergence,psychMessage=fit$res$message,psychCounts=fit$res$counts,referencePsi=unlist(raw$uniquenessParameters),referenceObjective=raw$objective)
}
write_json(output,stdout(),auto_unbox=TRUE,digits=17,pretty=TRUE)
