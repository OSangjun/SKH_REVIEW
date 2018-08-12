#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>
//#include <stdlib.h>

int main() {
	int  N, K,k;
	int d[11];
	d[0] = 1 ;

	scanf("%d %d", &N, &K);

	for ( k = 1; k <= K; k++) {
		d[k] = d[k-1] * (N - (k - 1)) / k ;
		//printf("%d ", d[k]);
	}

	printf("%d", d[k - 1]);

	//system("pause");
	return 0;
}