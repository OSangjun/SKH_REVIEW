#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>
#include <stdlib.h>
// MAX : 100,000


void sort(int *p,int len) {
	int maxi, tmp;
	for (int i = 0; i < len; i++) {
		maxi = i;
		for (int j = i + 1; j < len; j++) {
			if (p[maxi] < p[j]) {
				maxi = j;
			}
		}
		tmp = p[i];
		p[i] = p[maxi];
		p[maxi] = tmp;
	}
}

int main() {
	int n, k, coin[100], d[10001];
	int use[100] = {0};
	unsigned int ans;
	scanf("%d %d", &n, &k);

	for (int i = 0; i < n; i++)
		scanf("%d", coin + i);

	// sort
	sort(coin, n);

	//init 
	int tot = k;
	for (int i = n - 1; tot == 0 ; i--) {
		use[i] = tot / coin[i];
		tot -= coin[i] * use[i];
	}

	// sequence
	

	system("pause");
	return 0;
}