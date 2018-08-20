#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>
#include <stdlib.h>
int main() {

	int num = 0;
	char str[1000001];
	
	while (scanf("%s", str) != EOF) {
		num++;
	}
	printf("%d", num);

#ifdef _DEBUG
	system("pause");
#endif

	return 0;
}