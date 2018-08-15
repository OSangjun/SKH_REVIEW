#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>
#include <stdlib.h>
int main() {
	int N;
	int tmp;
	int val;
	int res[1000];

	scanf("%d", &N);
	for (int i = 0; i < N; i++) {
		val = 0;
		for (int j = 0; j < N; j++) {
			scanf("%d", &tmp);
			if (tmp) {
				val |= tmp;
			}
		}
	//	printf("%d ", val);
		res[i] = val;
	}

	for (int i = 0; i < N; i++)
		printf("%d ", res[i]);
	system("pause");
	
	return 0;
}